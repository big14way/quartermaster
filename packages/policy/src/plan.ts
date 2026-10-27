import { Decimal } from "decimal.js";
import { usdz, type Cents, type Role } from "@qm/core";
import { checkInvariants, invoiceRequiredUsd, refundFloor } from "./invariants";
import { fallbackChoice } from "./options";
import type { OptionId, PlanOption, PlanState, RoleState } from "./types";

export interface Allocation {
  sourcing: { cap: Cents; budget: Cents };
  support: { cap: Cents; budget: Cents };
  treasury: { cap: Cents; budget: Cents };
}

/**
 * The opening split. Treasury gets the licence fee at the live rate plus buffer, rounded
 * up to a whole USDZ; support keeps the template's reserve but never less than the refund
 * floor; sourcing gets the rest of the allocation. Returns the explanation shown on screen.
 */
export function initialAllocation(
  template: Allocation,
  state: Pick<PlanState, "invoice" | "usdPerEur" | "limits" | "forecast">,
  sourcingPrice: Cents,
): { allocation: Allocation; explanation: string[] } {
  const required = invoiceRequiredUsd(state);
  const tBudget = required % 100n === 0n ? required : required + (100n - (required % 100n));
  const floor = refundFloor(state);
  const rBudget = template.support.budget > floor ? template.support.budget : floor;
  const sBudget = state.limits.totalAllocation - tBudget - rBudget;
  const allocation: Allocation = {
    sourcing: { cap: template.sourcing.cap, budget: sBudget },
    support: { cap: template.support.cap, budget: rBudget },
    treasury: { cap: tBudget, budget: tBudget },
  };
  const explanation = [
    `Treasury T gets ${usdz(tBudget)}: the €${(Number(state.invoice.amount + state.invoice.feeEstimate) / 100).toFixed(2)} licence fee and transfer fee at ${new Decimal(state.usdPerEur).toFixed(4)} USD/EUR plus a ${Number(state.limits.fxBufferBps) / 100}% FX buffer is ${usdz(required)}, rounded up.`,
    `Support R gets ${usdz(rBudget)}: above the ${usdz(floor)} refund floor (P95 ${state.forecast.refundsP95PerHour} refunds/h × ${state.forecast.runwayHours}h × ${usdz(state.limits.sellPrice)}), with room to settle a disputed batch.`,
    `Sourcing S gets the rest, ${usdz(sBudget)}, with a ${usdz(template.sourcing.cap)} cap: ${(sBudget / sourcingPrice).toString()} calls at today's ${usdz(sourcingPrice)} price.`,
    `Σ budgets = ${usdz(sBudget + rBudget + tBudget)}, the full allocation. The account caps each budget; Quartermaster holds the sum.`,
  ];
  return { allocation, explanation };
}

/** A planner's structured answer, before the policy engine checks it. */
export interface PlannerChoice {
  option: OptionId;
  delta_usdz_cents: string;
  new_sourcing_cap_cents: string;
  ranking: OptionId[];
  explanation: string;
  rejected: { option: OptionId; why: string }[];
}

export interface ValidatedChoice {
  option: PlanOption;
  source: "planner" | "fallback";
  explanation: string;
  rejected: { option: OptionId; why: string }[];
  problems: string[];
}

/**
 * The model proposes; code decides. Its pick must be an enumerated, feasible option and its
 * numbers must equal the computed ones, or the fallback rule picks instead.
 */
export function validateChoice(options: PlanOption[], choice: PlannerChoice | undefined): ValidatedChoice {
  const fallback = fallbackChoice(options);
  if (!choice) return { option: fallback, source: "fallback", explanation: fallbackExplanation(options, fallback), rejected: [], problems: ["planner unavailable"] };
  const problems: string[] = [];
  const opt = options.find((o) => o.id === choice.option);
  if (!opt) problems.push(`option ${choice.option} was not enumerated`);
  else {
    if (!opt.feasible) problems.push(`option ${opt.id} is infeasible: ${opt.reasons[0] ?? ""}`);
    if (choice.delta_usdz_cents !== opt.delta.toString()) problems.push(`delta ${choice.delta_usdz_cents} ≠ computed ${opt.delta}`);
    // Options that leave mandate S alone carry no cap to check.
    const newCap = opt.changes.find((c) => c.role === "sourcing")?.new.cap;
    if (newCap !== undefined && choice.new_sourcing_cap_cents !== newCap.toString()) {
      problems.push(`new cap ${choice.new_sourcing_cap_cents} ≠ computed ${newCap}`);
    }
  }
  if (problems.length || !opt) {
    return { option: fallback, source: "fallback", explanation: fallbackExplanation(options, fallback), rejected: [], problems };
  }
  return { option: opt, source: "planner", explanation: choice.explanation, rejected: choice.rejected, problems };
}

export function fallbackExplanation(options: PlanOption[], chosen: PlanOption): string {
  const others = options
    .filter((o) => o.id !== chosen.id)
    .map((o) => `${o.id} ${o.feasible ? "is feasible but earns less" : `is out: ${o.reasons[0] ?? "infeasible"}`}`);
  return `Rule-based pick: ${chosen.id} (${chosen.title}) is the highest-margin feasible option. ${others.join("; ")}.`;
}

export function rolesFromStatus(entries: Record<Role, Omit<RoleState, "role">>): Record<Role, RoleState> {
  return {
    sourcing: { role: "sourcing", ...entries.sourcing },
    support: { role: "support", ...entries.support },
    treasury: { role: "treasury", ...entries.treasury },
  };
}

export { checkInvariants };
