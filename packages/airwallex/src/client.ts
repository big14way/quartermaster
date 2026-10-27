import { parse } from "lossless-json";
import { QmError, assertRequestId, sleep } from "@qm/core";
import type {
  AwxErrorBody,
  Balance,
  Beneficiary,
  BeneficiaryInput,
  Conversion,
  CurrentRate,
  Deposit,
  GlobalAccount,
  Page,
  Quote,
  Transfer,
  TransferStatus,
} from "./types";

export interface AirwallexConfig {
  baseUrl: string;
  clientId: string;
  apiKey: string;
  /** Global and per-endpoint request rates. The sandbox allows 20 and 10 rps; stay under. */
  globalRps?: number;
  endpointRps?: number;
  fetch?: typeof fetch;
}

/** Parse JSON keeping every number as its exact source text. */
export function parseLossless<T>(text: string): T {
  return parse(text, undefined, (value: string) => value) as T;
}

export class AirwallexError extends QmError {
  constructor(
    readonly status: number,
    readonly body: AwxErrorBody,
    readonly path: string,
  ) {
    super(body.code ?? `http_${status}`, `${path}: ${body.message ?? "request failed"}`, { status, ...body });
  }
}

const DUPLICATE_CODES = new Set(["duplicate_request_id", "duplicate_request"]);

class RateLimiter {
  private readonly slots = new Map<string, number[]>();
  constructor(
    private readonly globalRps: number,
    private readonly endpointRps: number,
  ) {}

  async take(endpoint: string) {
    for (;;) {
      const now = Date.now();
      const g = this.window("*", now);
      const e = this.window(endpoint, now);
      if (g.length < this.globalRps && e.length < this.endpointRps) {
        g.push(now);
        e.push(now);
        return;
      }
      const oldest = Math.min(g.length >= this.globalRps ? g[0]! : Infinity, e.length >= this.endpointRps ? e[0]! : Infinity);
      await sleep(Math.max(5, oldest + 1000 - now));
    }
  }

  private window(key: string, now: number): number[] {
    const list = (this.slots.get(key) ?? []).filter((t) => now - t < 1000);
    this.slots.set(key, list);
    return list;
  }
}

/**
 * Airwallex REST client. Talks to the sandbox in live mode and to the local simulator in
 * offline mode, which serves the same paths and shapes.
 */
export class AirwallexClient {
  private token?: { value: string; expiresAt: number };
  private tokenInFlight?: Promise<string>;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: AirwallexConfig) {
    this.limiter = new RateLimiter(cfg.globalRps ?? 15, cfg.endpointRps ?? 8);
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  // ---- auth -------------------------------------------------------------------------

  /** Single-flight token cache, refreshed 60 s before the 30-minute expiry. */
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.login().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  private async login(): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.cfg.clientId, "x-api-key": this.cfg.apiKey, "content-type": "application/json" },
      body: "{}",
    });
    const text = await res.text();
    if (!res.ok) throw new AirwallexError(res.status, safeError(text), "/api/v1/authentication/login");
    const body = parseLossless<{ token: string; expires_at: string }>(text);
    const expiresAt = Date.parse(body.expires_at) || Date.now() + 30 * 60_000;
    this.token = { value: body.token, expiresAt };
    return body.token;
  }

  // ---- transport --------------------------------------------------------------------

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    await this.limiter.take(path.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id"));
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 401) this.token = undefined;
    if (!res.ok) throw new AirwallexError(res.status, safeError(text), path);
    return (text ? parseLossless<T>(text) : undefined) as T;
  }

  /**
   * Retry wrapper for the two creates that carry a request_id. Network errors, 5xx and
   * `409 request_pending` retry with the *same* request_id; `duplicate_request_id` means
   * the first attempt landed, so load the existing object instead.
   */
  private async idempotentCreate<T>(
    requestId: string,
    create: () => Promise<T>,
    loadExisting: (id: string) => Promise<T>,
    attempts = 5,
  ): Promise<{ value: T; reused: boolean }> {
    assertRequestId(requestId);
    let delay = 300;
    for (let i = 1; ; i++) {
      try {
        return { value: await create(), reused: false };
      } catch (err) {
        if (err instanceof AirwallexError && DUPLICATE_CODES.has(err.body.code)) {
          const id = String(err.body.details?.id ?? "");
          if (!id) throw err;
          return { value: await loadExisting(id), reused: true };
        }
        const retryable =
          !(err instanceof AirwallexError) || err.status >= 500 || (err.status === 409 && err.body.code === "request_pending");
        if (!retryable || i >= attempts) throw err;
        await sleep(delay);
        delay *= 2;
      }
    }
  }

  // ---- accounts and balances --------------------------------------------------------

  balances(): Promise<Balance[]> {
    return this.call("GET", "/api/v1/balances/current");
  }

  async listGlobalAccounts(): Promise<GlobalAccount[]> {
    const page = await this.call<Page<GlobalAccount>>("GET", "/api/v1/global_accounts");
    return page.items;
  }

  createGlobalAccount(input: { request_id: string; country_code: string; currency: string; nick_name: string }): Promise<GlobalAccount> {
    assertRequestId(input.request_id);
    return this.call("POST", "/api/v1/global_accounts/create", {
      request_id: input.request_id,
      country_code: input.country_code,
      nick_name: input.nick_name,
      required_features: [{ currency: input.currency, transfer_method: "LOCAL" }],
    });
  }

  // ---- deposits (simulated ramp landing) -------------------------------------------

  simulateDeposit(input: { global_account_id: string; amount: string; reference: string; payer_name?: string }): Promise<Deposit> {
    return this.call("POST", "/api/v1/simulation/deposit/create", {
      amount: input.amount,
      global_account_id: input.global_account_id,
      reference: input.reference,
      payer_name: input.payer_name ?? "Quartermaster ramp",
      payer_country: "US",
      payer_bank_name: "Metal ramp",
    });
  }

  settleDeposit(id: string): Promise<Deposit> {
    return this.call("POST", `/api/v1/simulation/deposits/${id}/settle`, {});
  }

  listDeposits(q: { from_created_at?: string; to_created_at?: string; page_num?: number; page_size?: number } = {}): Promise<Page<Deposit>> {
    return this.call("GET", "/api/v1/deposits", undefined, q);
  }

  /**
   * GET /deposits filters by date only, so a reference lookup scans the pages. The sweep's
   * tx hash is the reference, which makes this the idempotency check before any create.
   */
  async findDepositByReference(reference: string, from_created_at?: string): Promise<Deposit | undefined> {
    for (let page_num = 0; page_num < 50; page_num++) {
      const page = await this.listDeposits({ from_created_at, page_num, page_size: 100 });
      const hit = page.items.find((d) => d.reference === reference);
      if (hit) return hit;
      if (!page.has_more) return undefined;
    }
    return undefined;
  }

  // ---- FX ---------------------------------------------------------------------------

  currentRate(q: { sell_currency: string; buy_currency: string; buy_amount?: string }): Promise<CurrentRate> {
    return this.call("GET", "/api/v1/fx/rates/current", undefined, q);
  }

  /** Never retried: a second quote is a different price. */
  createQuote(input: { sell_currency: string; buy_currency: string; buy_amount: string; validity?: string }): Promise<Quote> {
    return this.call("POST", "/api/v1/fx/quotes/create", { validity: "MIN_1", ...input });
  }

  getConversion(id: string): Promise<Conversion> {
    return this.call("GET", `/api/v1/fx/conversions/${id}`);
  }

  createConversion(input: { request_id: string; sell_currency: string; buy_currency: string; buy_amount: string; quote_id: string }) {
    return this.idempotentCreate(
      input.request_id,
      () => this.call<Conversion>("POST", "/api/v1/fx/conversions/create", { ...input, term_agreement: true }),
      (id) => this.getConversion(id),
    );
  }

  // ---- beneficiaries ----------------------------------------------------------------

  validateBeneficiary(input: BeneficiaryInput): Promise<{ status?: string; [k: string]: unknown }> {
    return this.call("POST", "/api/v1/beneficiaries/validate", input);
  }

  async listBeneficiaries(): Promise<Beneficiary[]> {
    const page = await this.call<Page<Beneficiary>>("GET", "/api/v1/beneficiaries");
    return page.items;
  }

  /** Never retried and carries no request_id, so callers match an existing one first. */
  createBeneficiary(input: BeneficiaryInput): Promise<Beneficiary> {
    return this.call("POST", "/api/v1/beneficiaries/create", input);
  }

  // ---- transfers --------------------------------------------------------------------

  getTransfer(id: string): Promise<Transfer> {
    return this.call("GET", `/api/v1/transfers/${id}`);
  }

  createTransfer(input: {
    request_id: string;
    beneficiary_id: string;
    source_currency: string;
    transfer_currency: string;
    transfer_amount: string;
    transfer_method: string;
    reference: string;
    reason: string;
  }) {
    return this.idempotentCreate(
      input.request_id,
      () => this.call<Transfer>("POST", "/api/v1/transfers/create", input),
      (id) => this.getTransfer(id),
    );
  }

  /** Sandbox-only. Never retried: a transition is not idempotent. */
  simulateTransferTransition(id: string, next_status: TransferStatus): Promise<Transfer> {
    return this.call("POST", `/api/v1/simulation/transfers/${id}/transition`, { next_status });
  }
}

export function beneficiaryId(b: Beneficiary): string {
  const id = b.beneficiary_id ?? b.id;
  if (!id) throw new Error("beneficiary response has no id");
  return id;
}

function safeError(text: string): AwxErrorBody {
  try {
    return parseLossless<AwxErrorBody>(text);
  } catch {
    return { code: "unparseable_error", message: text.slice(0, 300) };
  }
}
