import type { MandateChange, PlanOption, PlanState, RoleState, Terms } from "./types";

// Plan state crosses process boundaries as JSON with bigint written as strings. These
// put the bigints back.

const b = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v)));
const bo = (v: unknown): bigint | undefined => (v === undefined || v === null ? undefined : b(v));

function role(r: RoleState): RoleState {
  return { ...r, cap: b(r.cap), budget: b(r.budget), spent: b(r.spent) };
}

function terms(t: Terms): Terms {
  return { ...t, cap: b(t.cap), budget: b(t.budget) };
}

export function revivePlanState(j: PlanState): PlanState {
  return {
    ...j,
    roles: { sourcing: role(j.roles.sourcing), support: role(j.roles.support), treasury: role(j.roles.treasury) },
    balance: b(j.balance),
    suppliers: j.suppliers.map((s) => ({ ...s, price: b(s.price) })),
    trigger: j.trigger ? { ...j.trigger, price: b(j.trigger.price) } : undefined,
    invoice: { ...j.invoice, amount: b(j.invoice.amount), feeEstimate: b(j.invoice.feeEstimate) },
    forecast: {
      callsPerHour: b(j.forecast.callsPerHour),
      runwayHours: b(j.forecast.runwayHours),
      headroomCalls: b(j.forecast.headroomCalls),
      refundsP95PerHour: b(j.forecast.refundsP95PerHour),
      maxPassThroughBps: b(j.forecast.maxPassThroughBps),
    },
    limits: {
      totalAllocation: b(j.limits.totalAllocation),
      gasReserve: b(j.limits.gasReserve),
      sellPrice: b(j.limits.sellPrice),
      minMargin: b(j.limits.minMargin),
      fxBufferBps: b(j.limits.fxBufferBps),
      capRiseBps: b(j.limits.capRiseBps),
      deltaThreshold: b(j.limits.deltaThreshold),
    },
  };
}

export function reviveOptions(j: PlanOption[]): PlanOption[] {
  return j.map((o) => ({
    ...o,
    delta: b(o.delta),
    marginPerCall: b(o.marginPerCall),
    marginOverRunway: b(o.marginOverRunway),
    donorSlackAfter: bo(o.donorSlackAfter),
    changes: o.changes.map((c: MandateChange) => ({ ...c, old: terms(c.old), new: terms(c.new) })),
  }));
}
