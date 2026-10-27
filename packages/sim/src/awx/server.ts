import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { Decimal } from "decimal.js";
import { fromCents, toCents, type Cents } from "@qm/core";
import { signWebhook } from "@qm/airwallex";

export interface AwxSimConfig {
  file?: string;
  webhookUrl?: string;
  webhookSecret: string;
  /** EURUSD mid in market convention: USD per one EUR. */
  eurusd?: string;
  /** Spread applied against the client, in basis points. */
  spreadBps?: number;
  /** Fee for a LOCAL transfer, in the transfer currency's cents. */
  localFee?: Cents;
  /** Shuffle and delay webhook delivery so consumers cannot rely on order. */
  outOfOrderWebhooks?: boolean;
}

interface Doc {
  [k: string]: unknown;
}

interface State {
  balances: Record<string, string>;
  globalAccounts: Doc[];
  deposits: Doc[];
  quotes: Record<string, Doc & { expiresAt: number }>;
  conversions: Doc[];
  beneficiaries: Doc[];
  transfers: Doc[];
  requestIds: Record<string, string>;
  events: Doc[];
  eurusd: string;
  faults: { requestPendingOnce?: boolean; dropWebhooks?: boolean };
}

class AwxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const ACCOUNT_ID = "acct_sim_quartermaster";
const now = () => new Date().toISOString();
const shortRef = () => `P${randomBytes(4).toString("hex").toUpperCase()}`;

/**
 * Airwallex sandbox stand-in for offline runs. Same paths and response shapes as the
 * calls Quartermaster makes, the same idempotency rules (request_id duplicates name the
 * existing object), signed webhooks, and optional out-of-order delivery.
 */
export class AwxSim {
  private s: State;
  private readonly tokens = new Map<string, number>();

  constructor(readonly cfg: AwxSimConfig) {
    this.s =
      cfg.file && existsSync(cfg.file)
        ? (JSON.parse(readFileSync(cfg.file, "utf8")) as State)
        : {
            balances: { USD: "0.00", EUR: "0.00" },
            globalAccounts: [],
            deposits: [],
            quotes: {},
            conversions: [],
            beneficiaries: [],
            transfers: [],
            requestIds: {},
            events: [],
            eurusd: cfg.eurusd ?? "1.0850",
            faults: {},
          };
  }

  private save() {
    if (!this.cfg.file) return;
    mkdirSync(dirname(this.cfg.file), { recursive: true });
    writeFileSync(this.cfg.file, JSON.stringify(this.s));
  }

  private bal(ccy: string): Cents {
    return toCents(this.s.balances[ccy] ?? "0");
  }

  private setBal(ccy: string, v: Cents) {
    this.s.balances[ccy] = fromCents(v);
  }

  setRate(eurusd: string) {
    this.s.eurusd = eurusd;
    this.save();
  }

  setFaults(f: State["faults"]) {
    this.s.faults = f;
    this.save();
  }

  // ---- webhooks ---------------------------------------------------------------------

  private emit(name: string, object: Doc) {
    const event = { id: `evt_${randomUUID()}`, name, account_id: ACCOUNT_ID, created_at: now(), data: { object } };
    this.s.events.push(event);
    this.save();
    if (!this.cfg.webhookUrl || this.s.faults.dropWebhooks) return;
    const delay = this.cfg.outOfOrderWebhooks ? 50 + Math.floor(Math.random() * 900) : 20;
    setTimeout(() => void this.deliver(event, 0), delay);
  }

  private async deliver(event: Doc, attempt: number) {
    const raw = JSON.stringify(event);
    const ts = String(Date.now());
    try {
      const res = await fetch(this.cfg.webhookUrl!, {
        method: "POST",
        headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": signWebhook(this.cfg.webhookSecret, ts, raw) },
        body: raw,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch {
      if (attempt < 4) setTimeout(() => void this.deliver(event, attempt + 1), 400 * 2 ** attempt);
    }
  }

  /** Re-send every event, in a shuffled order: a webhook-storm drill. */
  replayWebhooks() {
    const events = [...this.s.events].sort(() => Math.random() - 0.5);
    for (const e of events) void this.deliver(e, 0);
    return events.length;
  }

  // ---- idempotency ------------------------------------------------------------------

  private claimRequestId(kind: string, requestId: unknown): void {
    if (typeof requestId !== "string" || !requestId) throw new AwxError(400, "validation_error", "request_id is required");
    if (requestId.length > 47) throw new AwxError(400, "validation_error", "request_id is too long");
    const existing = this.s.requestIds[`${kind}:${requestId}`];
    if (existing) throw new AwxError(400, "duplicate_request_id", "The request_id has been used", { id: existing });
  }

  // ---- handlers ---------------------------------------------------------------------

  login(clientId?: string, apiKey?: string) {
    if (!clientId || !apiKey) throw new AwxError(401, "credentials_invalid", "x-client-id and x-api-key are required");
    const token = `sim_${randomBytes(24).toString("hex")}`;
    const expiresAt = Date.now() + 30 * 60_000;
    this.tokens.set(token, expiresAt);
    return { token, expires_at: new Date(expiresAt).toISOString() };
  }

  checkToken(header?: string) {
    const token = header?.replace(/^Bearer\s+/i, "");
    const exp = token ? this.tokens.get(token) : undefined;
    if (!exp || exp < Date.now()) throw new AwxError(401, "unauthorized", "token missing or expired");
  }

  balances() {
    return Object.entries(this.s.balances).map(([currency, amount]) => ({
      currency,
      available_amount: amount,
      pending_amount: "0.00",
      reserved_amount: "0.00",
      total_amount: amount,
    }));
  }

  createGlobalAccount(body: Doc) {
    this.claimRequestId("ga", body.request_id);
    const feature = (body.required_features as { currency: string }[] | undefined)?.[0];
    const ga = {
      id: randomUUID(),
      request_id: body.request_id,
      country_code: body.country_code,
      currency: feature?.currency ?? (body.country_code === "US" ? "USD" : "EUR"),
      nick_name: body.nick_name,
      status: "ACTIVE",
      account_number: `${Math.floor(1e9 + Math.random() * 9e9)}`,
      required_features: body.required_features,
    };
    this.s.globalAccounts.push(ga);
    this.s.requestIds[`ga:${String(body.request_id)}`] = ga.id;
    this.save();
    return ga;
  }

  simulateDeposit(body: Doc) {
    const ga = this.s.globalAccounts.find((g) => g.id === body.global_account_id);
    if (!ga) throw new AwxError(400, "resource_not_found", "global account not found");
    const amount = fromCents(toCents(String(body.amount)));
    const dep = {
      id: randomUUID(),
      amount,
      currency: ga.currency,
      global_account_id: ga.id,
      reference: body.reference ?? "",
      payer_name: body.payer_name ?? "",
      status: "PENDING",
      created_at: now(),
    };
    this.s.deposits.push(dep);
    this.save();
    this.emit("deposit.pending", dep);
    return dep;
  }

  settleDeposit(id: string) {
    const dep = this.s.deposits.find((d) => d.id === id);
    if (!dep) throw new AwxError(404, "resource_not_found", "deposit not found");
    if (dep.status === "SETTLED") throw new AwxError(400, "invalid_status", "deposit already settled");
    dep.status = "SETTLED";
    dep.settled_at = now();
    this.setBal(String(dep.currency), this.bal(String(dep.currency)) + toCents(String(dep.amount)));
    this.save();
    this.emit("deposit.settled", dep);
    return dep;
  }

  listDeposits(q: Record<string, string | undefined>) {
    const from = q.from_created_at ?? "";
    const to = q.to_created_at ?? "￿";
    const size = Math.min(Number(q.page_size ?? 20), 100);
    const page = Number(q.page_num ?? 0);
    const all = this.s.deposits.filter((d) => String(d.created_at) >= from && String(d.created_at) <= to);
    return { items: all.slice(page * size, (page + 1) * size), has_more: (page + 1) * size < all.length };
  }

  private clientRate(sell: string, buy: string): Decimal {
    const mid = new Decimal(this.s.eurusd);
    const spread = new Decimal(this.cfg.spreadBps ?? 30).div(10_000);
    // Market convention for the pair is EURUSD whichever side is sold. The spread works
    // against the client: buying EUR costs more USD, buying USD returns fewer.
    if (sell === "USD" && buy === "EUR") return mid.mul(new Decimal(1).add(spread));
    if (sell === "EUR" && buy === "USD") return mid.mul(new Decimal(1).sub(spread));
    throw new AwxError(400, "unsupported_currency_pair", `${sell}/${buy} not offered by the simulator`);
  }

  currentRate(q: Record<string, string | undefined>) {
    const sell = q.sell_currency ?? "";
    const buy = q.buy_currency ?? "";
    return { sell_currency: sell, buy_currency: buy, currency_pair: "EURUSD", rate: this.clientRate(sell, buy).toFixed(4), created_at: now() };
  }

  private amounts(sell: string, buy: string, buyAmount: string, rate: Decimal) {
    const b = new Decimal(buyAmount);
    // EURUSD quote: when buying EUR, sell USD = EUR * rate; when buying USD, sell EUR = USD / rate.
    const sellAmt = sell === "USD" ? b.mul(rate) : b.div(rate);
    return { buy_amount: b.toFixed(2), sell_amount: sellAmt.toFixed(2, Decimal.ROUND_UP) };
  }

  createQuote(body: Doc) {
    const sell = String(body.sell_currency);
    const buy = String(body.buy_currency);
    if (!body.buy_amount) throw new AwxError(400, "validation_error", "buy_amount is required");
    const rate = this.clientRate(sell, buy);
    const validity = String(body.validity ?? "MIN_1");
    const seconds = validity === "MIN_1" ? 60 : validity === "MIN_15" ? 900 : 60;
    const from = Date.now();
    const quote = {
      quote_id: randomUUID(),
      sell_currency: sell,
      buy_currency: buy,
      ...this.amounts(sell, buy, String(body.buy_amount), rate),
      client_rate: rate.toFixed(4),
      currency_pair: "EURUSD",
      validity,
      valid_from_at: new Date(from).toISOString(),
      valid_to_at: new Date(from + seconds * 1000).toISOString(),
      expiresAt: from + seconds * 1000,
    };
    this.s.quotes[quote.quote_id] = quote;
    this.save();
    const { expiresAt: _e, ...out } = quote;
    return out;
  }

  createConversion(body: Doc) {
    this.claimRequestId("cv", body.request_id);
    const q = this.s.quotes[String(body.quote_id)];
    if (!q) throw new AwxError(400, "quote_not_found", "quote not found");
    if (q.expiresAt < Date.now()) throw new AwxError(400, "quote_expired", "the quote has expired; request a new one");
    if (q.buy_amount !== new Decimal(String(body.buy_amount)).toFixed(2)) throw new AwxError(400, "quote_mismatch", "buy_amount differs from the quote");
    const sellCents = toCents(String(q.sell_amount));
    const buyCents = toCents(String(q.buy_amount));
    const sell = String(q.sell_currency);
    const buy = String(q.buy_currency);
    if (this.bal(sell) < sellCents) throw new AwxError(400, "insufficient_fund", `insufficient ${sell} balance`);
    this.setBal(sell, this.bal(sell) - sellCents);
    this.setBal(buy, this.bal(buy) + buyCents);
    const conv = {
      conversion_id: randomUUID(),
      short_reference_id: shortRef(),
      request_id: body.request_id,
      status: "SETTLED",
      sell_currency: sell,
      buy_currency: buy,
      sell_amount: q.sell_amount,
      buy_amount: q.buy_amount,
      client_rate: q.client_rate,
      currency_pair: q.currency_pair,
      quote_id: q.quote_id,
      created_at: now(),
    };
    this.s.conversions.push(conv);
    this.s.requestIds[`cv:${String(body.request_id)}`] = conv.conversion_id;
    this.save();
    this.emit("conversion.settled", conv);
    return conv;
  }

  getConversion(id: string) {
    const c = this.s.conversions.find((x) => x.conversion_id === id);
    if (!c) throw new AwxError(404, "resource_not_found", "conversion not found");
    return c;
  }

  validateBeneficiary(body: Doc) {
    const b = body.beneficiary as { address?: Doc; bank_details?: Doc; company_name?: string } | undefined;
    const errors: { field: string; message: string }[] = [];
    if (!b?.company_name) errors.push({ field: "beneficiary.company_name", message: "required" });
    const bd = b?.bank_details ?? {};
    if (!bd.iban) errors.push({ field: "beneficiary.bank_details.iban", message: "required" });
    else if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(String(bd.iban))) errors.push({ field: "beneficiary.bank_details.iban", message: "invalid IBAN" });
    if (!bd.swift_code) errors.push({ field: "beneficiary.bank_details.swift_code", message: "required" });
    const addr = b?.address ?? {};
    if (["US", "ES"].includes(String(addr.country_code)) && !addr.state) errors.push({ field: "beneficiary.address.state", message: "required for this country" });
    if (errors.length) throw new AwxError(400, "validation_error", "beneficiary is invalid", { errors });
    // The sandbox answers NOT_MATCHED to payee-name checks; the simulator does too.
    return { status: "VALID", name_check: "NOT_MATCHED" };
  }

  createBeneficiary(body: Doc) {
    this.validateBeneficiary(body);
    const ben = { beneficiary_id: randomUUID(), ...body, created_at: now() };
    this.s.beneficiaries.push(ben);
    this.save();
    return ben;
  }

  createTransfer(body: Doc) {
    if (this.s.faults.requestPendingOnce) {
      this.s.faults.requestPendingOnce = false;
      this.save();
      throw new AwxError(409, "request_pending", "a request with this request_id is still being processed");
    }
    this.claimRequestId("tr", body.request_id);
    const ben = this.s.beneficiaries.find((b) => b.beneficiary_id === body.beneficiary_id);
    if (!ben) throw new AwxError(400, "beneficiary_not_found", "beneficiary not found");
    const ccy = String(body.transfer_currency);
    if (String(body.source_currency) !== ccy) throw new AwxError(400, "validation_error", "convert first: the simulator pays same-currency transfers only");
    const amount = toCents(String(body.transfer_amount));
    const fee = body.transfer_method === "LOCAL" ? (this.cfg.localFee ?? 15n) : 2500n;
    if (this.bal(ccy) < amount + fee) throw new AwxError(400, "insufficient_fund", `insufficient ${ccy} balance for amount plus fee`);
    this.setBal(ccy, this.bal(ccy) - amount - fee);
    const at = now();
    const tr = {
      id: randomUUID(),
      request_id: body.request_id,
      short_reference_id: shortRef(),
      status: "SCHEDULED",
      beneficiary_id: body.beneficiary_id,
      source_currency: body.source_currency,
      source_amount: fromCents(amount + fee),
      transfer_currency: ccy,
      transfer_amount: fromCents(amount),
      transfer_method: body.transfer_method,
      fee_amount: fromCents(fee),
      fee_currency: ccy,
      fee_paid_by: "PAYER",
      reference: body.reference,
      reason: body.reason,
      created_at: at,
      updated_at: at,
    };
    this.s.transfers.push(tr);
    this.s.requestIds[`tr:${String(body.request_id)}`] = tr.id;
    this.save();
    this.emit("payout.transfer.scheduled", tr);
    return tr;
  }

  getTransfer(id: string) {
    const t = this.s.transfers.find((x) => x.id === id);
    if (!t) throw new AwxError(404, "resource_not_found", "transfer not found");
    return t;
  }

  transition(id: string, next: string) {
    const t = this.getTransfer(id) as Doc;
    const allowed: Record<string, string[]> = {
      SCHEDULED: ["PROCESSING", "CANCELLED", "FAILED"],
      PROCESSING: ["SENT", "FAILED"],
      SENT: ["PAID", "FAILED"],
      PAID: ["FAILED"],
    };
    if (!(allowed[String(t.status)] ?? []).includes(next)) throw new AwxError(400, "invalid_transition", `cannot move a ${String(t.status)} transfer to ${next}`);
    if (next === "FAILED" || next === "CANCELLED") {
      // Funds come back; a LOCAL fee is kept on a bounce.
      const ccy = String(t.transfer_currency);
      this.setBal(ccy, this.bal(ccy) + toCents(String(t.transfer_amount)) + (next === "CANCELLED" ? toCents(String(t.fee_amount)) : 0n));
      if (next === "FAILED") t.failure_reason = "simulated bank rejection";
    }
    t.status = next;
    t.updated_at = now();
    this.save();
    this.emit(`payout.transfer.${next.toLowerCase()}`, { ...t });
    return t;
  }

  state() {
    return { ...this.s, quotes: Object.keys(this.s.quotes).length, simulated: true };
  }

  // ---- HTTP -------------------------------------------------------------------------

  app() {
    const app = express();
    app.use(express.json());
    const h =
      (fn: (req: Request) => unknown, auth = true) =>
      (req: Request, res: Response, next: NextFunction) => {
        try {
          if (auth) this.checkToken(req.header("authorization"));
          const out = fn(req);
          res.status(req.method === "POST" ? 201 : 200).json(out);
        } catch (err) {
          if (err instanceof AwxError) res.status(err.status).json({ code: err.code, message: err.message, source: "", details: err.details });
          else next(err);
        }
      };
    const qs = (req: Request) => req.query as Record<string, string | undefined>;

    app.get("/health", (_req, res) => res.json({ ok: true, simulated: true }));
    app.post("/api/v1/authentication/login", h((req) => this.login(req.header("x-client-id"), req.header("x-api-key")), false));
    app.get("/api/v1/balances/current", h(() => this.balances()));
    app.get("/api/v1/global_accounts", h(() => ({ items: this.s.globalAccounts, has_more: false })));
    app.post("/api/v1/global_accounts/create", h((req) => this.createGlobalAccount(req.body)));
    app.post("/api/v1/simulation/deposit/create", h((req) => this.simulateDeposit(req.body)));
    app.post("/api/v1/simulation/deposits/:id/settle", h((req) => this.settleDeposit(String(req.params.id))));
    app.get("/api/v1/deposits", h((req) => this.listDeposits(qs(req))));
    app.get("/api/v1/fx/rates/current", h((req) => this.currentRate(qs(req))));
    app.post("/api/v1/fx/quotes/create", h((req) => this.createQuote(req.body)));
    app.post("/api/v1/fx/conversions/create", h((req) => this.createConversion(req.body)));
    app.get("/api/v1/fx/conversions/:id", h((req) => this.getConversion(String(req.params.id))));
    app.post("/api/v1/beneficiaries/validate", h((req) => this.validateBeneficiary(req.body)));
    app.post("/api/v1/beneficiaries/create", h((req) => this.createBeneficiary(req.body)));
    app.get("/api/v1/beneficiaries", h(() => ({ items: this.s.beneficiaries, has_more: false })));
    app.post("/api/v1/transfers/create", h((req) => this.createTransfer(req.body)));
    app.get("/api/v1/transfers/:id", h((req) => this.getTransfer(String(req.params.id))));
    app.post("/api/v1/simulation/transfers/:id/transition", h((req) => this.transition(String(req.params.id), String(req.body.next_status))));

    // Simulator controls (not part of the Airwallex API).
    app.post("/sim/rate", h((req) => (this.setRate(String(req.body.eurusd)), { eurusd: this.s.eurusd }), false));
    app.post("/sim/faults", h((req) => (this.setFaults(req.body ?? {}), this.s.faults), false));
    app.post("/sim/webhooks/replay", h(() => ({ resent: this.replayWebhooks() }), false));
    app.get("/sim/state", h(() => this.state(), false));
    return app;
  }
}
