import { KIT, fromCents, getJson, mode, postJson, sleep, url, usdz, type EventLog, type QmEvent } from "@qm/core";
import { initialAllocation, invoiceRequiredUsd } from "@qm/policy";
import { callInternal, requireAccount } from "@qm/runtime";
import type { PlanDesk } from "./planning";

export const STEPS = [
  { id: "setup", title: "Accounts, mandates and the opening split", narration: "One Metal account gets 20 USDZ. The controller splits it across three mandates so the licence fee and refunds are covered, and the keyring binds them on chain. A customer with three buyer agents signs up." },
  { id: "sell", title: "Selling queries", narration: "Buyer agents pay 5 cents a call over x402 with a signed order. For each sale the sourcing agent buys a 2 cent quote from Feed A under mandate S. One upstream settlement times out: sourcing looks it up in /settlements instead of paying again. Feed A serves stale data for a few calls." },
  { id: "spike", title: "Supplier raises its price", narration: "Feed A goes to 4 cents and Feed B to 5. The next purchase is refused on chain with mandate_cap_exceeded. Buyers get a 503 and are not charged. The planner ranks the options." },
  { id: "approve", title: "Approval and mandate rewrite", narration: "The founder approves a change bound to its exact numbers. The keyring checks live state, replaces R and then S on chain, and both mandates verify. Sourcing resumes at the new price." },
  { id: "disputes", title: "Disputed batch", narration: "A buyer disputes five charges. Support checks each signed order against the chain and each delivery record, refunds the stale ones under R, and rejects the fresh one with evidence." },
  { id: "treasury", title: "Earnings to Airwallex, licence fee paid", narration: "Treasury sweeps to the ramp under T, lands it as a USD deposit referenced by the tx hash, converts on a MIN_1 quote and pays €5.00. The executor is killed after transfer create; the retry finds the same transfer." },
  { id: "drill", title: "Compromised agent drill", narration: "A compromised support agent tries to send itself 10 USDZ. The account refuses it on chain with mandate_cap_exceeded." },
  { id: "close", title: "Books close", narration: "Seven checks: Metal settlements, every mandate, the account balance, sweeps against deposits, and the USD and EUR accounts against the ledger, then I1–I5. The event log's hash chain is verified." },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export function invoiceText(): string {
  const l = KIT.licence;
  const due = new Date(Date.now() + l.dueInDays * 86_400_000).toISOString().slice(0, 10);
  const iban = l.iban.replace(/(.{4})/g, "$1 ").trim();
  return `From: ${l.vendor}
${l.street}, ${l.postcode} ${l.city}, Germany

Invoice no. ${l.invoiceId}
${l.description}

Bill to: Quartermaster

Total due: EUR ${fromCents(l.amount)}
Due date: ${due}
IBAN: ${iban}
BIC: ${l.bic}
Reference: ${l.invoiceId}

Payment by SEPA transfer. Quote the reference.`;
}

/** Drives the demo story through the same internal APIs the agents use. */
export class Director {
  running?: StepId;
  done: StepId[] = [];
  error?: string;

  constructor(
    private readonly bus: EventLog,
    private readonly desk: PlanDesk,
    private readonly snapshot: () => Promise<unknown>,
    private readonly reconcile: () => Promise<{ ok: boolean }>,
  ) {}

  private waitFor(pred: (e: QmEvent) => boolean, timeoutMs: number, since = 0): Promise<QmEvent> {
    const hit = this.bus.events.find((e) => e.seq > since && pred(e));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error("timed out waiting for the next event"));
      }, timeoutMs);
      const unsub = this.bus.subscribe((e) => {
        if (pred(e)) {
          clearTimeout(timer);
          unsub();
          resolve(e);
        }
      });
    });
  }

  async run(id: StepId) {
    if (this.running) throw new Error(`step ${this.running} is still running`);
    const step = STEPS.find((s) => s.id === id)!;
    this.running = id;
    this.error = undefined;
    this.bus.append({ type: "story.step", actor: "director", data: { id, title: step.title, narration: step.narration, status: "started" } });
    try {
      await this.steps[id]();
      this.done.push(id);
      this.bus.append({ type: "story.step", actor: "director", data: { id, title: step.title, status: "done" } });
      this.bus.append({ type: "live.snapshot", actor: "director", data: { after: id, live: await this.snapshot() } });
    } catch (err) {
      this.error = String((err as Error).message ?? err);
      this.bus.append({ type: "story.step", actor: "director", data: { id, title: step.title, status: "failed", error: this.error } });
      throw err;
    } finally {
      this.running = undefined;
    }
  }

  async runAll() {
    for (const s of STEPS) if (!this.done.includes(s.id)) await this.run(s.id);
  }

  private readonly steps: Record<StepId, () => Promise<void>> = {
    setup: async () => {
      const feeds = await Promise.all(["feedA", "feedB"].map((f) => getJson<{ id: string; name: string; payTo: string; url: string; price: string }>(`${url(f as "feedA")}/info`)));
      const rate = await getJson<{ usdPerEur: string }>(`${url("treasury")}/awx/rate`);
      const base = await this.desk.state().catch(() => undefined);
      const { allocation, explanation } = initialAllocation(
        KIT.initialPlan,
        {
          invoice: base?.invoice ?? {
            id: KIT.licence.invoiceId,
            vendor: KIT.licence.vendor,
            currency: "EUR",
            amount: KIT.licence.amount,
            feeEstimate: KIT.fx.feeEstimate,
            dueAt: new Date(Date.now() + KIT.licence.dueInDays * 86_400_000).toISOString(),
            paid: false,
          },
          usdPerEur: rate.usdPerEur,
          limits: {
            totalAllocation: KIT.totalAllocation,
            gasReserve: KIT.gasReserve,
            sellPrice: KIT.sellPrice,
            minMargin: KIT.minMargin,
            fxBufferBps: KIT.fx.bufferBps,
            capRiseBps: KIT.approval.capRiseBps,
            deltaThreshold: KIT.approval.deltaThreshold,
          },
          forecast: { ...KIT.forecast },
        },
        BigInt(feeds[0]!.price),
      );
      this.bus.append({ type: "plan.initial", actor: "controller", data: { allocation, explanation, usdPerEur: rate.usdPerEur } });
      const str = (r: { cap: bigint; budget: bigint }) => ({ cap: fromCents(r.cap), budget: fromCents(r.budget) });
      await callInternal("keyring", "/bootstrap", {
        planId: "plan_initial",
        explanation,
        feeds: feeds.map((f) => ({ id: f.id, name: f.name, payTo: f.payTo, url: f.url })),
        allocation: { sourcing: str(allocation.sourcing), support: str(allocation.support), treasury: str(allocation.treasury) },
      });
      const { account } = requireAccount();
      await callInternal("buyers", "/bootstrap", { payTo: account });
      await callInternal("treasury", "/setup");
      await callInternal("treasury", "/invoice", { text: invoiceText() });
    },

    sell: async () => {
      await callInternal("buyers", "/run", { count: 9 });
      if (mode() === "offline") {
        // Timeout drill: the next settlement lands on chain but its receipt "times out".
        await postJson(`${url("simnet")}/admin/fault`, { nextSettle: "settlement_in_doubt" });
        await callInternal("buyers", "/run", { count: 1 });
      }
      await callInternal("feedA", "/admin/degrade", { on: true });
      await callInternal("buyers", "/run", { count: 4, only: KIT.customer.buyers[0] });
      await callInternal("feedA", "/admin/degrade", { on: false });
      await callInternal("buyers", "/run", { count: 12 });
    },

    spike: async () => {
      const since = this.bus.events.length;
      await callInternal("feedA", "/admin/price", { price: fromCents(KIT.feeds.A.spikePrice) });
      await callInternal("feedB", "/admin/price", { price: fromCents(KIT.feeds.B.spikePrice) });
      await callInternal("buyers", "/run", { count: 3 });
      await this.waitFor((e) => ["plan.submitted", "plan.applied", "plan.escalated", "plan.failed"].includes(e.type), 120_000, since);
    },

    approve: async () => {
      const planId = this.desk.open?.planId;
      if (!planId) throw new Error("no open plan");
      const end = await this.waitFor(
        (e) => (e.data as { planId?: string }).planId === planId && ["plan.verified", "plan.verify_failed", "plan.rejected", "plan.escalated"].includes(e.type),
        30 * 60_000,
      );
      if (end.type !== "plan.verified") throw new Error(`plan ended ${end.type}`);
      await callInternal("buyers", "/run", { count: 9 });
    },

    disputes: async () => {
      await callInternal("buyers", "/dispute", { buyer: KIT.customer.buyers[0], includeFresh: 1 });
    },

    treasury: async () => {
      const state = await this.desk.state();
      const amount = invoiceRequiredUsd(state);
      const since = this.bus.events.length;
      await callInternal("treasury", "/sweep", { sweepId: "sweep-1", amount: fromCents(amount) });
      await this.waitFor((e) => e.type === "awx.deposit_settled", 60_000, since);
      await callInternal("treasury", "/pay-invoice", { invoiceId: state.invoice.id, drill: "crash-after-create" });
      await this.waitFor((e) => e.type === "awx.transfer_status" && (e.data as { status?: string; ignored?: boolean }).status === "PAID" && !(e.data as { ignored?: boolean }).ignored, 60_000, since);
      this.bus.append({ type: "story.note", actor: "director", data: { text: `Swept ${usdz(amount)}: the fee and transfer fee at the live rate plus buffer.` } });
    },

    drill: async () => {
      await callInternal("support", "/drill/self-refund", { amount: "10.00" });
    },

    close: async () => {
      await sleep(1500);
      const r = await this.reconcile();
      if (!r.ok) throw new Error("reconciliation found a mismatch");
    },
  };
}
