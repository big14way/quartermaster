import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT, QmError, logger, postJson, sleep, url, usdz, varDir, type Address } from "@qm/core";
import { internalHeaders, jsonApp, metalRail, report, requireInternal, route, serve } from "@qm/runtime";
import { writeJson } from "@qm/sim";

// The customer: a separate business with its own Metal account. Its three buyer agents
// each pay under their own mandate on that account, capped at 10 cents a call and allowed
// to pay one payee: Quartermaster. They keep every receipt, and flag stale data.

const log = logger("buyers");
const dir = varDir("buyers");
const ownerKeyFile = join(dir, "owner-key.json");
const stateFile = join(dir, "state.json");
const rail = metalRail({ ownerKeyFile, home: dir });

interface Buyer {
  name: string;
  credential: string;
  mandateKey: string;
  mandateId: string;
}

interface Receipt {
  buyer: string;
  symbol: string;
  tx: string;
  amount: string;
  as_of: string;
  ageMs: number;
  stale: boolean;
}

interface State {
  account?: Address;
  buyers: Buyer[];
  receipts: Receipt[];
}

const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { buyers: [], receipts: [] };
const save = () => writeJson(stateFile, state, 0o600);

const app = jsonApp();

app.post("/bootstrap", requireInternal, route(async (req) => {
  if (state.account) return { account: state.account, buyers: state.buyers.map((b) => b.name) };
  const payTo = req.body.payTo as Address;
  const { account, tx } = await rail.createAccount();
  const funded = await rail.fund(account, KIT.customer.funding);
  state.account = account;
  for (const name of KIT.customer.buyers) {
    const out = join(dir, name, "credential.json");
    const cred = await rail.createCredential({
      principal: account,
      terms: { ...KIT.customer.mandate, payees: [{ address: payTo, name: "Quartermaster" }], description: `${name}: buys market snapshots` },
      out,
    });
    await rail.bind(cred.credentialPath);
    state.buyers.push({ name, credential: cred.credentialPath, mandateKey: cred.mandateKeyPath, mandateId: cred.mandateId });
  }
  save();
  report("buyers", "customer.ready", {
    account,
    tx,
    fundingTx: funded.tx,
    funded: funded.amount,
    buyers: state.buyers.map((b) => ({ name: b.name, mandateId: b.mandateId })),
    cap: KIT.customer.mandate.cap,
    budget: KIT.customer.mandate.budget,
  });
  return { account, buyers: state.buyers.map((b) => b.name) };
}));

app.post("/run", requireInternal, route(async (req) => {
  const count = Number(req.body.count ?? 10);
  const delayMs = Number(req.body.delayMs ?? 150);
  const symbols: string[] = req.body.symbols ?? KIT.symbols;
  const tally = { paid: 0, notCharged: 0, refused: 0, spent: 0n };
  for (let i = 0; i < count; i++) {
    const b = state.buyers[i % state.buyers.length]!;
    const symbol = symbols[i % symbols.length]!;
    const res = await rail.payer(b.credential, b.mandateKey).pay(`${url("seller")}/v1/snapshot?symbol=${symbol}`);
    if (res.paid) {
      const body = res.body as { as_of: string; served_at: string };
      const ageMs = Date.parse(body.served_at) - Date.parse(body.as_of);
      const r: Receipt = { buyer: b.name, symbol, tx: res.paid.tx, amount: String(res.paid.amount), as_of: body.as_of, ageMs, stale: ageMs > 60_000 };
      state.receipts.push(r);
      tally.paid += 1;
      tally.spent += res.paid.amount;
      report("buyers", "buyer.paid", { buyer: b.name, symbol, tx: r.tx, amount: res.paid.amount, stale: r.stale });
    } else if (res.refusal?.stage === "seller") {
      tally.notCharged += 1;
      report("buyers", "buyer.not_charged", { buyer: b.name, symbol, status: res.status });
    } else {
      tally.refused += 1;
      report("buyers", "buyer.refused", { buyer: b.name, symbol, code: res.refusal?.code });
    }
    if (delayMs) await sleep(delayMs);
  }
  save();
  return { ...tally, spent: usdz(tally.spent) };
}));

/** File a dispute for this buyer's flagged charges, plus any extra refs it wants checked. */
app.post("/dispute", requireInternal, route(async (req) => {
  const name = String(req.body.buyer ?? KIT.customer.buyers[0]);
  const stale = state.receipts.filter((r) => r.buyer === name && r.stale);
  const fresh = state.receipts.filter((r) => r.buyer === name && !r.stale);
  const extra = Number(req.body.includeFresh ?? 1);
  const batch = [...stale, ...fresh.slice(-extra)];
  if (!batch.length) throw new QmError("nothing_to_dispute", `${name} has no charges to dispute`, { status: 409 });
  const lines = batch.map((r) => `- ${r.tx} (${r.symbol}, quote as of ${r.as_of})`);
  const text = [
    `Dispute from ${name}, on account ${state.account}.`,
    `We were charged for ${batch.length} snapshots in the last batch. ${stale.length} of them returned stale quotes, about ${Math.round((stale[0]?.ageMs ?? 0) / 60000)} minutes old, which is outdated data for our use. The last one also looked off to us. Please refund the bad data.`,
    "",
    ...lines,
  ].join("\n");
  report("buyers", "dispute.filed", { buyer: name, charges: batch.map((r) => r.tx), text });
  return postJson(`${url("controller")}/api/disputes`, { claimId: `dsp-${Date.now()}`, buyer: name, principal: state.account, text }, internalHeaders());
}));

app.get("/info", route(() => ({ account: state.account, buyers: state.buyers.map((b) => ({ name: b.name, mandateId: b.mandateId })), receipts: state.receipts.length })));

serve(app, "buyers", "buyers");
log.info(`${KIT.customer.buyers.length} buyer agents, cap ${usdz(KIT.customer.mandate.cap)} each`);
