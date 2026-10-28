import { ROLES, baseUnitsToCents, fromCents, getJson, sumCents, toCents, url, usdz, verifyChain, type Cents, type EventLog, type Role } from "@qm/core";
import { ACCOUNTS as A, postings } from "@qm/ledger";
import { checkInvariants } from "@qm/policy";
import { callInternal, credentialHistory, publicFiles, requireAccount, type Rail } from "@qm/runtime";
import type { Balance, Conversion, Deposit, Transfer } from "@qm/airwallex";
import type { Books } from "./books";
import type { PlanDesk } from "./planning";

export interface Check {
  id: number;
  title: string;
  ok: boolean;
  left: string;
  right: string;
  detail: string;
  links?: { label: string; href: string }[];
}

interface Snapshot {
  balances: Balance[];
  /** Balances at the run's first setup; the sandbox account outlives runs and starts seeded. */
  opening?: Balance[];
  deposits: Deposit[];
  transfers: Transfer[];
  conversions: Conversion[];
}

const fmt = (c: Cents, ccy = "USDZ") => (ccy === "USDZ" ? usdz(c) : `${ccy} ${fromCents(c)}`);

/**
 * Seven checks that close the books: Metal settlements, every mandate's on-chain record,
 * the account balance, the ramp sweeps against Airwallex deposits, and the USD and EUR
 * accounts against the ledger, then the invariants. Each check compares two sides that
 * come from different systems.
 */
export async function reconcile(bus: EventLog, books: Books, desk: PlanDesk, rail: Rail): Promise<{ ok: boolean; checks: Check[]; chain: ReturnType<typeof verifyChain> }> {
  const { ledger } = books;
  const account = requireAccount();
  const checks: Check[] = [];
  const snap = await getJson<Snapshot>(`${url("treasury")}/awx/snapshot`);
  books.foldSnapshot(snap as never);

  // 1. Facilitator settlements to our account = sales in the ledger.
  const rows = await rail.settlements(account.account);
  // A settlement with no sale booked means the buyer paid but our seller never recorded the
  // sale (e.g. the buyer's call timed out mid-settle). Book it from the chain record, and have
  // support refund it: nothing was delivered for it.
  for (const r of rows) {
    if (ledger.has("metal:settlement", r.id)) continue;
    const amount = baseUnitsToCents(r.amount, "up");
    ledger.post(postings.sale(r.id, amount, { tx: r.transaction, payer: r.payer, recovered: true }));
    bus.append({ type: "sale.recovered", actor: "controller", data: { settlementId: r.id, tx: r.transaction, payer: r.payer, amount } });
    try {
      await callInternal("support", "/refund", { settlementId: r.id, to: r.payer, amount: fromCents(amount), why: "settled on chain but never delivered" });
    } catch (err) {
      bus.append({ type: "sale.recovered_refund_failed", actor: "controller", data: { settlementId: r.id, error: String((err as Error).message ?? err) } });
    }
  }
  await new Promise((res) => setTimeout(res, 1500));
  const settled = sumCents(rows.map((r) => baseUnitsToCents(r.amount, "up")));
  const sales = -ledger.balance(A.sales, "USDZ");
  const saleEntries = ledger.entries("metal:settlement").length;
  checks.push({
    id: 1,
    title: "Facilitator settlements = sales booked",
    ok: settled === sales && rows.length === saleEntries,
    left: `${rows.length} settlements, ${fmt(settled)}`,
    right: `${saleEntries} sales, ${fmt(sales)}`,
    detail: "GET /settlements?payTo=<account> against income:sales",
  });

  // 2. Every mandate, current and replaced, verifies from the chain; its spend = the ledger's.
  const ledgerSpend: Record<Role, Cents> = {
    sourcing: ledger.balance(A.sourcing, "USDZ"),
    support: ledger.balance(A.refunds, "USDZ"),
    treasury: sumCents(ledger.entries("metal:sweep").map((e) => e.lines.find((l) => l.account === A.rampInTransit)!.amount)),
  };
  const per: string[] = [];
  let allVerified = true;
  let spendMatches = true;
  for (const role of ROLES) {
    let verified = true;
    for (const cred of credentialHistory(role)) {
      const v = await rail.verify({ credentialPath: cred, issuerPublicPaths: [publicFiles.issuer] });
      verified &&= v.verified;
    }
    const status = await rail.status(publicFiles.credential(role));
    allVerified &&= verified;
    spendMatches &&= status.spent === ledgerSpend[role];
    per.push(`${role} ${verified ? "verified" : "FAILED"} ${credentialHistory(role).length}×, chain ${fmt(status.spent)} / ledger ${fmt(ledgerSpend[role])}`);
  }
  checks.push({
    id: 2,
    title: "Every mandate verifies on chain, spend = ledger",
    ok: allVerified && spendMatches,
    left: `${ROLES.reduce((n, r) => n + credentialHistory(r).length, 0)} mandates checked`,
    right: allVerified ? "all four verify steps pass" : "a verification failed",
    detail: per.join("; "),
  });

  // 3. On-chain balance = funding + sales − sourcing − refunds − sweeps.
  const onChain = await rail.balanceOf(account.account);
  const booked = ledger.balance(A.metalAccount, "USDZ");
  checks.push({
    id: 3,
    title: "Account balance on chain = ledger",
    ok: onChain === booked,
    left: `chain ${fmt(onChain)}`,
    right: `ledger ${fmt(booked)}`,
    detail: `funding ${fmt(-ledger.balance(A.capital, "USDZ"))} + sales ${fmt(sales)} − sourcing ${fmt(ledgerSpend.sourcing)} − refunds ${fmt(ledgerSpend.support)} − sweeps ${fmt(ledgerSpend.treasury)}`,
  });

  // 4. Σ sweeps (USDZ) = Σ settled Airwallex deposits whose reference is a sweep tx (USD, 1:1).
  const sweepTxs = ledger.entries("metal:sweep").map((e) => e.externalId);
  const matched = snap.deposits.filter((d) => sweepTxs.includes(d.reference ?? "") && d.status === "SETTLED");
  const depTotal = sumCents(matched.map((d) => toCents(d.amount)));
  const onePerSweep = sweepTxs.every((tx) => snap.deposits.filter((d) => d.reference === tx).length === 1);
  checks.push({
    id: 4,
    title: "Ramp sweeps = Airwallex deposits by tx hash",
    ok: depTotal === ledgerSpend.treasury && onePerSweep && sweepTxs.length > 0,
    left: `${sweepTxs.length} sweeps, ${fmt(ledgerSpend.treasury)}`,
    right: `${matched.length} deposits, ${fmt(depTotal, "USD")}`,
    detail: onePerSweep ? "each sweep tx is the reference of exactly one deposit" : "a sweep has no deposit or more than one",
  });

  // 5. USD: deposits − conversion sells = USD balance moved since setup = ledger.
  const held = (list: Balance[] | undefined, ccy: string) => toCents(list?.find((b) => b.currency === ccy)?.available_amount ?? "0");
  const moved = (ccy: string) => held(snap.balances, ccy) - held(snap.opening, ccy);
  const usd = moved("USD");
  const sold = sumCents(snap.conversions.filter((c) => c.sell_currency === "USD").map((c) => toCents(c.sell_amount)));
  checks.push({
    id: 5,
    title: "USD account: deposits − conversions = balance",
    // Never below the opening balance: the run spends only what it brought in.
    ok: usd >= 0n && depTotal - sold === usd && ledger.balance(A.awxUSD, "USD") === usd,
    left: `${fmt(depTotal, "USD")} − ${fmt(sold, "USD")}`,
    right: `balance ${fmt(usd, "USD")}, ledger ${fmt(ledger.balance(A.awxUSD, "USD"), "USD")}`,
    detail: "GET /balances/current, less the balance at setup, against awx:USD",
  });

  // 6. EUR: bought = transfer + fee; transfer PAID; licence payable = 0.
  const eur = moved("EUR");
  const bought = sumCents(snap.conversions.filter((c) => c.buy_currency === "EUR").map((c) => toCents(c.buy_amount)));
  const paid = snap.transfers.filter((t) => t.status === "PAID");
  const out = sumCents(paid.map((t) => toCents(t.transfer_amount) + toCents(t.fee_amount ?? "0")));
  const payable = ledger.balance(A.licencePayable, "EUR");
  checks.push({
    id: 6,
    title: "EUR: bought = licence fee + transfer fee, paid",
    ok: paid.length > 0 && eur >= 0n && bought - out === eur && payable === 0n && ledger.balance(A.awxEUR, "EUR") === eur,
    left: `bought ${fmt(bought, "EUR")}`,
    right: `paid ${fmt(out, "EUR")} (${paid.map((t) => `${t.transfer_amount} + fee ${t.fee_amount}`).join(", ") || "none"}), left ${fmt(eur, "EUR")}`,
    detail: `licence payable ${fmt(payable, "EUR")}; transfer ${paid.map((t) => t.status).join(", ") || snap.transfers.map((t) => t.status).join(", ") || "not created"}`,
  });

  // 7. I1–I5 hold at the end of the run.
  const inv = checkInvariants(await desk.state());
  checks.push({
    id: 7,
    title: "Invariants I1–I5 hold",
    ok: inv.every((i) => i.ok),
    left: inv.map((i) => `${i.id} ${i.ok ? "✓" : "✗"}`).join(" "),
    right: inv.every((i) => i.ok) ? "all hold" : inv.filter((i) => !i.ok).map((i) => i.detail).join("; "),
    detail: inv.map((i) => `${i.id}: ${i.detail}`).join(" | "),
  });

  const chain = verifyChain(bus.events);
  const ok = checks.every((c) => c.ok) && chain.ok;
  bus.append({ type: "recon.result", actor: "controller", data: { ok, checks, chain: { ok: chain.ok, count: chain.count, head: chain.head } } });
  return { ok, checks, chain };
}
