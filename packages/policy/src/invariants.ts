import { Decimal } from "decimal.js";
import { ROLES, fromCents, sumCents, toCents, usdz, type Cents, type Role } from "@qm/core";
import type { InvariantResult, PlanState, RoleState } from "./types";

export const remaining = (r: Pick<RoleState, "budget" | "spent">): Cents => r.budget - r.spent;

/** USD the treasury must be able to sweep to pay the invoice: (amount + fee) × rate × (1 + buffer), rounded up. */
export function invoiceRequiredUsd(state: Pick<PlanState, "invoice" | "usdPerEur" | "limits">): Cents {
  const eur = new Decimal(fromCents(state.invoice.amount + state.invoice.feeEstimate));
  const buffer = new Decimal(1).add(new Decimal(state.limits.fxBufferBps.toString()).div(10_000));
  return toCents(eur.mul(state.usdPerEur).mul(buffer).toFixed(2, Decimal.ROUND_UP));
}

export function refundFloor(state: Pick<PlanState, "forecast" | "limits">): Cents {
  return state.forecast.refundsP95PerHour * state.forecast.runwayHours * state.limits.sellPrice;
}

/**
 * I1–I5, checked before every plan and after every block Quartermaster acts on. The
 * account enforces each mandate's budget on its own; the sum is ours to enforce.
 */
export function checkInvariants(state: PlanState, roles: Record<Role, RoleState> = state.roles): InvariantResult[] {
  const list = ROLES.map((r) => roles[r]);
  const sumBudget = sumCents(list.map((r) => r.budget));
  const sumRemaining = sumCents(list.map(remaining));
  const solvency = state.balance - state.limits.gasReserve;
  const i1 = sumBudget <= state.limits.totalAllocation && sumRemaining <= solvency;

  const required = invoiceRequiredUsd(state);
  const remT = remaining(roles.treasury);
  const i2 = state.invoice.paid || remT >= required;

  const floor = refundFloor(state);
  const remR = remaining(roles.support);
  const i3 = remR >= floor;

  const capLimit = state.limits.sellPrice - state.limits.minMargin;
  const i4 = roles.sourcing.cap <= capLimit;

  const live = list.filter((r) => !r.revoked);
  const ids = new Set(list.map((r) => r.mandateId));
  const i5 = live.length === ROLES.length && ids.size === ROLES.length;

  return [
    {
      id: "I1",
      ok: i1,
      title: "Budgets fit the allocation and the balance",
      detail: `Σ budgets ${usdz(sumBudget)} ≤ ${usdz(state.limits.totalAllocation)}; Σ remaining ${usdz(sumRemaining)} ≤ balance − gas ${usdz(solvency)}`,
    },
    {
      id: "I2",
      ok: i2,
      title: "Treasury covers the licence fee",
      detail: state.invoice.paid
        ? `invoice ${state.invoice.id} already paid`
        : `remaining T ${usdz(remT)} ≥ €${fromCents(state.invoice.amount + state.invoice.feeEstimate)} × ${new Decimal(state.usdPerEur).toFixed(4)} × (1 + ${fromCents(state.limits.fxBufferBps)}%) = ${usdz(required)}`,
    },
    {
      id: "I3",
      ok: i3,
      title: "Refund floor holds",
      detail: `remaining R ${usdz(remR)} ≥ P95 ${state.forecast.refundsP95PerHour}/h × ${state.forecast.runwayHours}h × ${usdz(state.limits.sellPrice)} = ${usdz(floor)}`,
    },
    {
      id: "I4",
      ok: i4,
      title: "Never buy above what we sell for",
      detail: `cap S ${usdz(roles.sourcing.cap)} ≤ sell ${usdz(state.limits.sellPrice)} − margin ${usdz(state.limits.minMargin)} = ${usdz(capLimit)}`,
    },
    {
      id: "I5",
      ok: i5,
      title: "One live mandate per role",
      detail: i5 ? "S, R and T each have exactly one live mandate" : `${live.length} live mandates across ${ids.size} ids`,
    },
  ];
}

export const allHold = (results: InvariantResult[]) => results.every((r) => r.ok);
