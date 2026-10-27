import {
  KIT,
  ROLES,
  getJson,
  mode,
  newId,
  url,
  type Address,
  type EventLog,
  type QmEvent,
  type Role,
} from "@qm/core";
import {
  approvalRecord,
  checkInvariants,
  enumerateOptions,
  validateChoice,
  type Invoice,
  type PlanOption,
  type PlanState,
  type PlannerChoice,
  type RoleState,
} from "@qm/policy";
import { callInternal, credentialHistory, publicFiles, requireAccount, type Rail } from "@qm/runtime";

interface Offer {
  id: string;
  name: string;
  payTo: Address;
  price?: string;
  healthy: boolean;
}

export interface OpenPlan {
  planId: string;
  status: string;
  trigger: { supplier: string; price: bigint; offerHash: string; code: string; tx?: string };
  option?: string;
}

async function blockNumber(): Promise<number> {
  if (mode() === "offline") return (await getJson<{ block: number }>(`${url("simnet")}/health`)).block;
  const { createPublicClient, http } = await import("viem");
  return Number(await createPublicClient({ transport: http(process.env.METAL_RPC_URL) }).getBlockNumber());
}

/**
 * The planning desk. A refused purchase opens a plan; the desk reads live state, has code
 * enumerate the options, asks the treasury agent's planner to rank them, validates the
 * pick, and sends a proposal to the keyring. It can propose; it cannot approve.
 */
export class PlanDesk {
  open?: OpenPlan;
  invoice?: Invoice;
  private readonly declined = new Set<string>();

  constructor(
    private readonly bus: EventLog,
    private readonly rail: Rail,
  ) {}

  async state(trigger?: OpenPlan["trigger"]): Promise<PlanState> {
    const account = requireAccount();
    const statuses = await Promise.all(ROLES.map((r) => this.rail.status(publicFiles.credential(r))));
    const roles = Object.fromEntries(
      ROLES.map((r, i) => {
        const s = statuses[i]!;
        const rs: RoleState = { role: r, mandateId: s.mandateId, cap: s.cap, budget: s.budget, spent: s.spent, payees: s.payees, revoked: s.revoked };
        return [r, rs];
      }),
    ) as Record<Role, RoleState>;
    const [balance, block, offers, sup, rate] = await Promise.all([
      this.rail.balanceOf(account.account),
      blockNumber(),
      getJson<Offer[]>(`${url("sourcing")}/offers`),
      getJson<{ supplier: string }>(`${url("sourcing")}/supplier`),
      getJson<{ usdPerEur: string }>(`${url("treasury")}/awx/rate`),
    ]);
    const listed = new Set((roles.sourcing.payees ?? []).map((p) => p.toLowerCase()));
    return {
      roles,
      balance,
      block,
      suppliers: offers.map((o) => ({ id: o.id, name: o.name, address: o.payTo, price: BigInt(o.price ?? "0"), listed: listed.has(o.payTo.toLowerCase()), healthy: o.healthy })),
      currentSupplier: sup.supplier,
      trigger: trigger && { supplier: trigger.supplier, price: trigger.price, offerHeaderSha256: trigger.offerHash, refusal: { code: trigger.code, tx: trigger.tx } },
      invoice: this.invoice ?? {
        id: KIT.licence.invoiceId,
        vendor: KIT.licence.vendor,
        currency: "EUR",
        amount: KIT.licence.amount,
        feeEstimate: KIT.fx.feeEstimate,
        dueAt: new Date(Date.now() + KIT.licence.dueInDays * 86_400_000).toISOString(),
        paid: false,
      },
      usdPerEur: rate.usdPerEur,
      forecast: { ...KIT.forecast },
      limits: {
        totalAllocation: KIT.totalAllocation,
        gasReserve: KIT.gasReserve,
        sellPrice: KIT.sellPrice,
        minMargin: KIT.minMargin,
        fxBufferBps: KIT.fx.bufferBps,
        capRiseBps: KIT.approval.capRiseBps,
        deltaThreshold: KIT.approval.deltaThreshold,
      },
    };
  }

  onEvent(e: QmEvent) {
    const d = e.data as Record<string, unknown>;
    if (e.type === "invoice.booked") {
      this.invoice = {
        id: String(d.id),
        vendor: String(d.vendor),
        currency: "EUR",
        amount: BigInt(String(d.amount)),
        feeEstimate: KIT.fx.feeEstimate,
        dueAt: `${String(d.dueDate)}T17:00:00Z`,
        paid: false,
      };
    }
    if (e.type === "awx.transfer_status" && d.status === "PAID" && this.invoice) this.invoice.paid = true;
    if (e.type === "sourcing.refused" && d.code === "mandate_cap_exceeded") {
      const key = `${String(d.supplier)}:${String(d.price)}`;
      const busy = this.open && !["Verified", "Escalated", "Rejected", "Refused", "Failed"].includes(this.open.status);
      if (!busy && !this.declined.has(key)) {
        void this.openPlan({ supplier: String(d.supplier), price: BigInt(String(d.price)), offerHash: String(d.offerHash), code: String(d.code), tx: d.tx ? String(d.tx) : undefined });
      }
    }
    if (!this.open || d.planId !== this.open.planId) return;
    if (e.type === "plan.applied") void this.verify(this.open.planId);
    if (e.type === "plan.rejected" || e.type === "plan.escalated") {
      this.open.status = e.type === "plan.rejected" ? "Rejected" : "Escalated";
      this.declined.add(`${this.open.trigger.supplier}:${this.open.trigger.price}`);
      void callInternal("sourcing", "/pause", { paused: true, reason: `plan ${this.open.status.toLowerCase()}` });
    }
    if (e.type === "plan.refused") {
      // The keyring saw drift between approval and execution. Re-plan from fresh state once.
      const t = this.open.trigger;
      this.open.status = "Refused";
      this.bus.append({ type: "plan.replanning", actor: "controller", data: { planId: d.planId, drift: d.drift } });
      void this.openPlan(t);
    }
  }

  async openPlan(trigger: OpenPlan["trigger"]) {
    const planId = newId("plan", 4);
    this.open = { planId, status: "Proposed", trigger };
    this.bus.append({ type: "plan.opened", actor: "controller", data: { planId, trigger } });
    try {
      const state = await this.state(trigger);
      if (trigger.price <= state.roles.sourcing.cap) {
        // The cap already covers this price (a refusal that raced a replace). Nothing to plan.
        this.open.status = "Verified";
        this.bus.append({ type: "plan.dismissed", actor: "controller", data: { planId, why: `cap S is already ${state.roles.sourcing.cap} cents` } });
        return;
      }
      const options = enumerateOptions(state);
      this.bus.append({
        type: "plan.options",
        actor: "controller",
        data: {
          planId,
          invariantsBefore: checkInvariants(state),
          usdPerEur: state.usdPerEur,
          balance: state.balance,
          block: state.block,
          options: options.map(summariseOption),
        },
      });
      const planner = await callInternal<{ choice?: PlannerChoice; source: string; model: string; error?: string }>("treasury", "/propose", { planId, state, options });
      const v = validateChoice(options, planner.choice);
      this.open.option = v.option.id;
      this.bus.append({
        type: "plan.chosen",
        actor: "controller",
        data: {
          planId,
          option: v.option.id,
          title: v.option.title,
          source: v.source,
          planner: { source: planner.source, model: planner.model, error: planner.error, pick: planner.choice?.option, ranking: planner.choice?.ranking },
          explanation: v.explanation,
          rejected: v.rejected,
          problems: v.problems,
          needsApproval: v.option.needsApproval,
          approvalReasons: v.option.approvalReasons,
        },
      });

      if (v.option.id === "A") {
        await callInternal("sourcing", "/supplier", { id: v.option.supplier });
        this.bus.append({ type: "plan.applied", actor: "controller", data: { planId, option: "A", supplier: v.option.supplier } });
        return;
      }
      if (v.option.id === "E" || v.option.id === "D") {
        await callInternal("sourcing", "/pause", { paused: true, reason: "no feasible plan" });
        this.bus.append({ type: "plan.escalated", actor: "controller", data: { planId, reason: v.explanation } });
        return;
      }
      const expires = new Date(Date.now() + KIT.approval.ttlSeconds * 1000).toISOString();
      const record = approvalRecord(state, v.option, planId, v.explanation, expires);
      this.open.status = "Submitted";
      const r = await callInternal<{ hash: string; status: string; approveUrl?: string }>("keyring", "/proposals", {
        record,
        needsApproval: v.option.needsApproval,
        approvalReasons: v.option.approvalReasons,
      });
      this.open.status = r.status;
      this.bus.append({ type: "plan.submitted", actor: "controller", data: { planId, hash: r.hash, status: r.status, approveUrl: r.approveUrl, record } });
    } catch (err) {
      this.open.status = "Failed";
      this.bus.append({ type: "plan.failed", actor: "controller", data: { planId, error: String((err as Error).message ?? err) } });
    }
  }

  /** After the keyring applies a plan: verify every changed role's mandates from the chain, and I1–I5. */
  async verify(planId: string) {
    try {
      const verifications = [];
      for (const role of ROLES) {
        const history = credentialHistory(role);
        if (history.length < 2) continue;
        for (const cred of history.slice(-2)) {
          const v = await this.rail.verify({ credentialPath: cred, issuerPublicPaths: [publicFiles.issuer] });
          verifications.push({ role, mandateId: v.mandateId, verified: v.verified, steps: v.steps, payments: v.payments.length });
        }
      }
      const state = await this.state();
      const invariants = checkInvariants(state);
      const ok = verifications.every((v) => v.verified) && invariants.every((i) => i.ok);
      if (this.open?.planId === planId) this.open.status = ok ? "Verified" : "Failed";
      this.bus.append({ type: ok ? "plan.verified" : "plan.verify_failed", actor: "controller", data: { planId, verifications, invariants } });
    } catch (err) {
      this.bus.append({ type: "plan.verify_failed", actor: "controller", data: { planId, error: String(err) } });
    }
  }
}

export function summariseOption(o: PlanOption) {
  return {
    id: o.id,
    title: o.title,
    feasible: o.feasible,
    reasons: o.reasons,
    delta: o.delta,
    marginPerCall: o.marginPerCall,
    marginOverRunway: o.marginOverRunway,
    donorSlackAfter: o.donorSlackAfter,
    needsApproval: o.needsApproval,
    approvalReasons: o.approvalReasons,
    changes: o.changes,
    invariantsAfter: o.invariantsAfter,
  };
}
