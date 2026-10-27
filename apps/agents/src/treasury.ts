import { join } from "node:path";
import type { Express } from "express";
import { AirwallexError, beneficiaryId, orientRate, sellPerBuy, type BeneficiaryInput, type Deposit, type Transfer, type TransferStatus } from "@qm/airwallex";
import { KIT, QmError, fromCents, mode, paymentIds, requestIds, sleep, toCents, usdz, type Cents } from "@qm/core";
import { DocStore } from "@qm/ledger";
import { extractInvoice, planWithClaude } from "@qm/planner";
import { reviveOptions, revivePlanState, type PlanOption, type PlanState } from "@qm/policy";
import { airwallex, report, requireAccount, requireInternal, route } from "@qm/runtime";
import type { AgentContext } from "./common";

interface Sweep {
  id: string;
  amount: string;
  status: "Planned" | "Pulled" | "DepositSimulated" | "Settled";
  tx?: string;
  depositId?: string;
}

interface InvoiceDoc {
  id: string;
  vendor: string;
  currency: "EUR";
  amount: string;
  iban: string;
  bic: string;
  dueDate: string;
  reference: string;
  attempt: number;
  status: "Validated" | "Quoted" | "Converted" | "TransferCreated" | "Paid" | "Failed";
  quoteId?: string;
  conversionId?: string;
  transferId?: string;
}

/** ISO 13616 mod-97 check. */
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

/**
 * The treasury agent: the only process with the Airwallex API key, and the holder of
 * mandate T, whose one payee is the ramp address. It proposes plans (through the
 * planner), sweeps earnings to the ramp, lands them as a USD deposit referenced by the
 * Metal tx hash, converts to EUR on a MIN_1 quote and pays the licence fee.
 */
export function mountTreasury(app: Express, ctx: AgentContext) {
  const awx = airwallex();
  const docs = new DocStore(join(ctx.files.dir, "treasury.sqlite"));
  const env = mode();

  async function ensureAccounts() {
    const existing = await awx.listGlobalAccounts();
    const find = (ccy: string) => existing.find((g) => g.currency === ccy || (g.required_features ?? []).some((f) => f.currency === ccy));
    const usd = find("USD") ?? (await awx.createGlobalAccount({ request_id: requestIds.globalAccount("USD", env), country_code: "US", currency: "USD", nick_name: "Quartermaster earnings (USD)" }));
    const eur = find("EUR") ?? (await awx.createGlobalAccount({ request_id: requestIds.globalAccount("EUR", env), country_code: "DE", currency: "EUR", nick_name: "Quartermaster payables (EUR)" }));
    return { usd, eur };
  }

  function beneficiaryInput(inv: InvoiceDoc): BeneficiaryInput {
    const l = KIT.licence;
    return {
      nickname: inv.vendor,
      transfer_methods: ["LOCAL"],
      beneficiary: {
        entity_type: "COMPANY",
        company_name: inv.vendor,
        address: { city: l.city, country_code: l.country, postcode: l.postcode, street_address: l.street },
        bank_details: { account_currency: "EUR", account_name: inv.vendor, bank_country_code: inv.iban.slice(0, 2), iban: inv.iban, swift_code: inv.bic, local_clearing_system: "SEPA" },
      },
    };
  }

  /** Beneficiary create has no request_id, so match an existing one by IBAN first. */
  async function ensureBeneficiary(inv: InvoiceDoc): Promise<string> {
    const list = await awx.listBeneficiaries();
    const hit = list.find((b) => b.beneficiary?.bank_details?.iban === inv.iban);
    if (hit) return beneficiaryId(hit);
    const input = beneficiaryInput(inv);
    const v = await awx.validateBeneficiary(input);
    report("treasury", "beneficiary.validated", { vendor: inv.vendor, iban: inv.iban, result: v });
    const created = await awx.createBeneficiary(input);
    report("treasury", "beneficiary.created", { vendor: inv.vendor, beneficiaryId: beneficiaryId(created) });
    return beneficiaryId(created);
  }

  async function rate(): Promise<{ usdPerEur: string; pair: string; raw: string }> {
    const r = await awx.currentRate({ sell_currency: "USD", buy_currency: "EUR" });
    return { usdPerEur: orientRate(r).toFixed(6), pair: r.currency_pair, raw: r.rate };
  }

  app.post("/setup", requireInternal, route(async () => {
    const { usd, eur } = await ensureAccounts();
    report("treasury", "awx.accounts_ready", { usd: usd.id, eur: eur.id });
    return { usd: usd.id, eur: eur.id };
  }));

  app.get("/awx/rate", route(() => rate()));

  app.get("/awx/snapshot", route(async () => {
    const deposits: Deposit[] = [];
    for (let page = 0; page < 20; page++) {
      const p = await awx.listDeposits({ page_num: page, page_size: 100 });
      deposits.push(...p.items);
      if (!p.has_more) break;
    }
    const inv = docs.list<InvoiceDoc>("invoices");
    const transfers: Transfer[] = [];
    for (const i of inv) if (i.transferId) transfers.push(await awx.getTransfer(i.transferId));
    const conversions = await Promise.all(inv.filter((i) => i.conversionId).map((i) => awx.getConversion(i.conversionId!)));
    return { balances: await awx.balances(), deposits, transfers, conversions, sweeps: docs.list<Sweep>("sweeps"), invoices: inv };
  }));

  app.post("/invoice", requireInternal, route(async (req) => {
    const out = await extractInvoice(String(req.body.text), ctx.recorder);
    const f = out.fields;
    const problems: string[] = [];
    if (f.currency !== "EUR") problems.push(`currency ${f.currency} is not EUR`);
    if (!/^\d+(\.\d{1,2})?$/.test(f.amount)) problems.push(`amount "${f.amount}" is not a decimal`);
    if (!ibanValid(f.iban)) problems.push(`IBAN ${f.iban} fails its checksum`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.due_date)) problems.push(`due date "${f.due_date}" is not a date`);
    if (problems.length) {
      report("treasury", "invoice.rejected", { fields: f, problems, source: out.source });
      throw new QmError("invoice_invalid", problems.join("; "), { status: 422 });
    }
    const doc: InvoiceDoc = {
      id: f.invoice_id,
      vendor: f.vendor,
      currency: "EUR",
      amount: fromCents(toCents(f.amount)),
      iban: f.iban,
      bic: f.bic,
      dueDate: f.due_date,
      reference: f.payment_reference || f.invoice_id,
      attempt: 1,
      status: "Validated",
    };
    docs.create("invoices", doc.id, doc);
    report("treasury", "invoice.booked", { id: doc.id, vendor: doc.vendor, amount: toCents(doc.amount), currency: "EUR", dueDate: doc.dueDate, iban: doc.iban, source: out.source, model: out.model });
    return docs.get<InvoiceDoc>("invoices", doc.id);
  }));

  app.post("/propose", requireInternal, route(async (req) => {
    const state: PlanState = revivePlanState(req.body.state);
    const options: PlanOption[] = reviveOptions(req.body.options);
    const result = await planWithClaude(state, options, ctx.recorder);
    report("treasury", "plan.proposed_by_planner", { planId: req.body.planId, source: result.source, model: result.model, error: result.error, choice: result.choice });
    return result;
  }));

  // ---- sweep: Planned → Pulled(tx) → DepositSimulated(ref = tx) → Settled ------------

  app.post("/sweep", requireInternal, route(async (req) => {
    const id = String(req.body.sweepId);
    const amount: Cents = toCents(String(req.body.amount));
    docs.create<Sweep>("sweeps", id, { id, amount: fromCents(amount), status: "Planned" });
    let s = docs.get<Sweep>("sweeps", id)!;
    const { ramp } = requireAccount();

    if (s.status === "Planned") {
      // A pull that ends pending is re-run with the same --to, --amount and --payment-id: it pays at most once.
      for (let i = 0; i < 5; i++) {
        const out = await ctx.rail.pull({ credentialPath: ctx.files.credential, mandateKeyPath: ctx.files.mandateKey, to: ramp, amount, paymentId: paymentIds.sweep(id) });
        if (out.outcome === "paid") {
          s = docs.put("sweeps", id, { ...s, status: "Pulled", tx: out.tx });
          report("treasury", "sweep.pulled", { sweepId: id, amount, tx: out.tx, to: ramp, spent: out.spent, budget: out.budget, explorer: out.explorer });
          break;
        }
        if (out.outcome === "refused") {
          report("treasury", "sweep.refused", { sweepId: id, amount, reason: out.reason });
          throw new QmError(out.reason, `sweep refused: ${out.reason}`, { status: 409 });
        }
        await sleep(1000);
      }
    }
    const { usd } = await ensureAccounts();
    if (s.status === "Pulled") {
      // The tx hash is the deposit's idempotency key: look before creating.
      const existing = await awx.findDepositByReference(s.tx!);
      const dep = existing ?? (await awx.simulateDeposit({ global_account_id: usd.id, amount: s.amount, reference: s.tx! }));
      s = docs.put("sweeps", id, { ...s, status: "DepositSimulated", depositId: dep.id });
      report("treasury", "deposit.simulated", { sweepId: id, depositId: dep.id, amount, reference: s.tx, reused: !!existing });
    }
    if (s.status === "DepositSimulated") {
      const found = await awx.findDepositByReference(s.tx!);
      if (found?.status !== "SETTLED") await awx.settleDeposit(s.depositId!).catch((err) => {
        if (!(err instanceof AirwallexError && err.body.code === "invalid_status")) throw err;
      });
      s = docs.put("sweeps", id, { ...s, status: "Settled" });
      report("treasury", "sweep.settled", { sweepId: id, depositId: s.depositId, amount, reference: s.tx });
    }
    return s;
  }));

  // ---- invoice: Validated → Quoted (MIN_1) → Converted → TransferCreated → SENT → PAID ---

  app.post("/pay-invoice", requireInternal, route(async (req) => {
    const id = String(req.body.invoiceId);
    const drill = req.body.drill === "crash-after-create";
    let inv = docs.get<InvoiceDoc>("invoices", id);
    if (!inv) throw new QmError("not_found", `invoice ${id} not booked`, { status: 404 });
    const fee = KIT.fx.feeEstimate;
    const buy = toCents(inv.amount) + fee;

    if (!inv.conversionId) {
      const quote = await awx.createQuote({ sell_currency: "USD", buy_currency: "EUR", buy_amount: fromCents(buy), validity: "MIN_1" });
      inv = docs.put("invoices", id, { ...inv, status: "Quoted", quoteId: quote.quote_id });
      report("treasury", "fx.quoted", {
        invoiceId: id,
        quoteId: quote.quote_id,
        pair: quote.currency_pair,
        clientRate: quote.client_rate,
        usdPerEur: sellPerBuy(quote).toFixed(6),
        sellUSD: toCents(quote.sell_amount),
        buyEUR: toCents(quote.buy_amount),
        validTo: quote.valid_to_at,
      });
      const conv = await awx.createConversion({ request_id: requestIds.conversion(id, inv.attempt), sell_currency: "USD", buy_currency: "EUR", buy_amount: fromCents(buy), quote_id: quote.quote_id });
      inv = docs.put("invoices", id, { ...inv, status: "Converted", conversionId: conv.value.conversion_id });
      report("treasury", "fx.converted", {
        invoiceId: id,
        conversionId: conv.value.conversion_id,
        requestId: conv.value.request_id,
        sellUSD: toCents(conv.value.sell_amount),
        buyEUR: toCents(conv.value.buy_amount),
        reused: conv.reused,
      });
    }

    const beneficiary = await ensureBeneficiary(inv);
    const body = {
      request_id: requestIds.transfer(id, inv.attempt),
      beneficiary_id: beneficiary,
      source_currency: "EUR",
      transfer_currency: "EUR",
      transfer_amount: inv.amount,
      transfer_method: "LOCAL",
      reference: inv.reference,
      reason: "professional_business_services",
    };
    let transfer: Transfer;
    if (!inv.transferId) {
      const first = await awx.createTransfer(body);
      if (drill) {
        // The executor dies after Airwallex accepted the transfer but before we stored its id.
        report("treasury", "drill.crashed", { invoiceId: id, requestId: body.request_id, note: "executor killed after transfers/create returned; transfer id not stored" });
        await sleep(600);
        const retry = await awx.createTransfer(body);
        report("treasury", "drill.recovered", { invoiceId: id, requestId: body.request_id, transferId: retry.value.id, reused: retry.reused, sameTransfer: retry.value.id === first.value.id });
        transfer = retry.value;
      } else transfer = first.value;
      inv = docs.put("invoices", id, { ...inv, status: "TransferCreated", transferId: transfer.id });
      report("treasury", "transfer.created", { invoiceId: id, transferId: transfer.id, requestId: body.request_id, amount: toCents(transfer.transfer_amount), fee: toCents(transfer.fee_amount ?? "0"), currency: "EUR" });
    } else transfer = await awx.getTransfer(inv.transferId);

    if (env === "offline" || req.body.simulate !== false) {
      // Sandbox only: walk the transfer through its states. Webhooks report each one.
      for (const next of ["PROCESSING", "SENT", "PAID"] as TransferStatus[]) {
        const cur = await awx.getTransfer(transfer.id);
        if (["PAID", "FAILED", "CANCELLED"].includes(cur.status)) break;
        const order = ["SCHEDULED", "PROCESSING", "SENT", "PAID"];
        if (order.indexOf(cur.status) >= order.indexOf(next)) continue;
        await sleep(500);
        await awx.simulateTransferTransition(transfer.id, next);
      }
    }
    return { invoiceId: id, transferId: transfer.id, sweepNeeded: usdz(buy) };
  }));
}
