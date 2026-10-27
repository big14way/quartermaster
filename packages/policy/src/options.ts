import { Decimal } from "decimal.js";
import { ceilTo, changeBps, fromCents, maxCents, usdz, type Cents, type Role } from "@qm/core";
import { checkInvariants, invoiceRequiredUsd, refundFloor, remaining } from "./invariants";
import type { MandateChange, OptionId, PlanOption, PlanState, RoleState, Terms } from "./types";

const termsOf = (r: RoleState): Terms => ({ cap: r.cap, budget: r.budget, payees: r.payees });
const LETTER: Record<Role, string> = { sourcing: "S", support: "R", treasury: "T" };

/**
 * Budget to move to sourcing at the new price: enough for H hours of forecast demand
 * beyond what sourcing has left, plus headroom calls, rounded up to 10 cents.
 */
export function deltaFor(state: PlanState, newPrice: Cents): Cents {
  const f = state.forecast;
  const need = newPrice * f.callsPerHour * f.runwayHours;
  const shortfall = maxCents(0n, need - remaining(state.roles.sourcing));
  return ceilTo(shortfall + newPrice * f.headroomCalls, 10n);
}

function withChanges(state: PlanState, changes: MandateChange[]): Record<Role, RoleState> {
  const roles = { ...state.roles };
  for (const c of changes) roles[c.role] = { ...roles[c.role], cap: c.new.cap, budget: c.new.budget, payees: c.new.payees };
  return roles;
}

export function approvalReasons(state: PlanState, id: OptionId, changes: MandateChange[], delta: Cents): string[] {
  const reasons: string[] = [];
  for (const c of changes) {
    const rise = changeBps(c.old.cap, c.new.cap);
    if (rise > state.limits.capRiseBps) {
      reasons.push(`cap ${LETTER[c.role]} rises ${(Number(rise) / 100).toFixed(0)}% (autonomy limit ${Number(state.limits.capRiseBps) / 100}%)`);
    }
  }
  if (delta > state.limits.deltaThreshold) reasons.push(`moves ${usdz(delta)} (autonomy limit ${usdz(state.limits.deltaThreshold)})`);
  if (id === "C") reasons.push("touches the money set aside for the licence fee");
  return reasons;
}

interface Draft {
  id: OptionId;
  title: string;
  changes?: MandateChange[];
  delta?: Cents;
  marginPerCall: Cents;
  /** Reasons the option cannot work. Any blocker makes it infeasible. */
  blockers?: string[];
  /** Context that does not block. */
  notes?: string[];
  supplier?: string;
  donorSlackAfter?: Cents;
  alwaysFeasible?: boolean;
}

function build(state: PlanState, d: Draft): PlanOption {
  const changes = d.changes ?? [];
  const delta = d.delta ?? 0n;
  const after = checkInvariants(state, withChanges(state, changes));
  const failing = changes.length ? after.filter((r) => !r.ok).map((r) => `${r.id} would fail: ${r.detail}`) : [];
  const blockers = [...(d.blockers ?? []), ...failing];
  const feasible = d.alwaysFeasible || blockers.length === 0;
  const calls = state.forecast.callsPerHour * state.forecast.runwayHours;
  const approvals = approvalReasons(state, d.id, changes, delta);
  return {
    id: d.id,
    title: d.title,
    feasible,
    reasons: [...blockers, ...(d.notes ?? [])],
    changes,
    delta,
    supplier: d.supplier,
    marginPerCall: d.marginPerCall,
    marginOverRunway: feasible ? d.marginPerCall * calls : 0n,
    donorSlackAfter: d.donorSlackAfter,
    invariantsAfter: after,
    needsApproval: approvals.length > 0,
    approvalReasons: approvals,
  };
}

/**
 * Every option with its numbers, computed in code. The planner may rank these and explain
 * the choice; it can neither invent an option nor change a number.
 */
export function enumerateOptions(state: PlanState): PlanOption[] {
  if (!state.trigger) throw new Error("options need a trigger offer");
  const p = state.trigger.price;
  const { sourcing: S, support: R, treasury: T } = state.roles;
  const sell = state.limits.sellPrice;
  const capLimit = sell - state.limits.minMargin;
  const delta = deltaFor(state, p);
  const marginBlock = p > capLimit ? [`${usdz(p)} is above what we can pay and keep a ${usdz(state.limits.minMargin)} margin`] : [];

  // A. Switch supplier: no mandate change if another listed supplier is within the cap.
  const alternatives = state.suppliers.filter((s) => s.id !== state.trigger!.supplier);
  const best = alternatives.filter((s) => s.listed && s.healthy && s.price <= S.cap).sort((a, b) => Number(a.price - b.price))[0];
  const a = build(state, {
    id: "A",
    title: best ? `Switch to ${best.name} at ${usdz(best.price)}` : "Switch supplier",
    marginPerCall: best ? sell - best.price : 0n,
    supplier: best?.id,
    blockers: best
      ? []
      : alternatives.length
        ? alternatives.map((s) =>
            !s.listed
              ? `${s.name} is not on mandate S's payee list`
              : !s.healthy
                ? `${s.name} is not answering`
                : `${s.name} asks ${usdz(s.price)}, above cap S ${usdz(S.cap)}${s.price > capLimit ? ` and above the ${usdz(capLimit)} margin limit` : ""}`,
          )
        : ["no other supplier is listed"],
  });

  // B. Raise cap S to the new price, funded from the refund budget.
  const b = build(state, {
    id: "B",
    title: `Raise cap S to ${usdz(p)}, +${usdz(delta)} from refunds`,
    changes: [
      { role: "support", mandateId: R.mandateId, old: termsOf(R), new: { ...termsOf(R), budget: R.budget - delta } },
      { role: "sourcing", mandateId: S.mandateId, old: termsOf(S), new: { ...termsOf(S), cap: p, budget: S.budget + delta } },
    ],
    delta,
    marginPerCall: sell - p,
    supplier: state.trigger.supplier,
    donorSlackAfter: remaining(R) - delta - refundFloor(state),
    blockers: [
      ...marginBlock,
      ...(R.budget - delta <= R.spent ? [`support has spent ${usdz(R.spent)}; its budget cannot drop to ${usdz(R.budget - delta)}`] : []),
    ],
  });

  // C. Raise cap S to the new price, funded from the treasury budget.
  const required = invoiceRequiredUsd(state);
  const tAfter = remaining(T) - delta;
  const invoiceShort: string[] = [];
  if (!state.invoice.paid && tAfter < required) {
    const short = required - tAfter;
    const pct = new Decimal(fromCents(short)).div(fromCents(required)).mul(100).toFixed(0);
    invoiceShort.push(
      `it would leave the ${state.invoice.vendor} licence fee ${usdz(short)} (${pct}%) short at ${new Decimal(state.usdPerEur).toFixed(4)} USD/EUR: treasury would hold ${usdz(tAfter)} against ${usdz(required)} needed by ${state.invoice.dueAt.slice(0, 10)}`,
    );
  }
  const c = build(state, {
    id: "C",
    title: `Raise cap S to ${usdz(p)}, +${usdz(delta)} from treasury`,
    changes: [
      { role: "treasury", mandateId: T.mandateId, old: termsOf(T), new: { ...termsOf(T), budget: T.budget - delta } },
      { role: "sourcing", mandateId: S.mandateId, old: termsOf(S), new: { ...termsOf(S), cap: p, budget: S.budget + delta } },
    ],
    delta,
    marginPerCall: sell - p,
    supplier: state.trigger.supplier,
    donorSlackAfter: tAfter - required,
    blockers: [
      ...marginBlock,
      ...invoiceShort,
      ...(T.budget - delta <= T.spent ? [`treasury has spent ${usdz(T.spent)}; its budget cannot drop to ${usdz(T.budget - delta)}`] : []),
    ],
  });
  // I2 already explains C's failure in plain words; drop the duplicate invariant line.
  if (invoiceShort.length) c.reasons = c.reasons.filter((r) => !r.startsWith("I2 would fail"));

  // D. Pass the price through: raise our own price. It does not lift the on-chain cap.
  const passPrice = p + (sell - S.cap);
  const maxPrice = sell + (sell * state.forecast.maxPassThroughBps) / 10_000n;
  const d = build(state, {
    id: "D",
    title: `Pass the price through: sell at ${usdz(passPrice)}`,
    marginPerCall: passPrice - p,
    blockers: [
      `cap S stays ${usdz(S.cap)}, so the account still refuses a ${usdz(p)} purchase; D does nothing on its own`,
      ...(passPrice > maxPrice ? [`${usdz(passPrice)} is more than ${Number(state.forecast.maxPassThroughBps) / 100}% above today's ${usdz(sell)}`] : []),
    ],
  });

  // E. Pause sourcing and escalate: always possible, costs the revenue.
  const e = build(state, {
    id: "E",
    title: "Pause sourcing and escalate to the founder",
    marginPerCall: 0n,
    alwaysFeasible: true,
    notes: [`loses about ${usdz(state.forecast.callsPerHour * sell)} of sales per hour while paused`],
  });
  e.marginOverRunway = 0n;

  return [a, b, c, d, e];
}

/**
 * The deterministic rule used when the planner is unavailable: the highest-margin feasible
 * option, ties broken by the larger slack left in the donor budget; E when nothing else is
 * feasible.
 */
export function fallbackChoice(options: PlanOption[]): PlanOption {
  const feasible = options.filter((o) => o.feasible && o.id !== "E");
  if (!feasible.length) return options.find((o) => o.id === "E")!;
  return [...feasible].sort((x, y) => {
    if (x.marginOverRunway !== y.marginOverRunway) return x.marginOverRunway > y.marginOverRunway ? -1 : 1;
    const sx = x.donorSlackAfter ?? 0n;
    const sy = y.donorSlackAfter ?? 0n;
    return sx === sy ? 0 : sx > sy ? -1 : 1;
  })[0]!;
}

/** Shrink donors before growing the receiver, so I1 holds at every block. */
export function executionOrder(changes: MandateChange[]): MandateChange[] {
  return [...changes].sort((x, y) => {
    const dx = x.new.budget - x.old.budget;
    const dy = y.new.budget - y.old.budget;
    return dx < dy ? -1 : dx > dy ? 1 : 0;
  });
}
