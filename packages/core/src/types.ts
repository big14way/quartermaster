import type { Cents } from "./money";

export type Role = "sourcing" | "support" | "treasury";
export const ROLES: readonly Role[] = ["sourcing", "support", "treasury"] as const;

export const ROLE_LABEL: Record<Role, string> = {
  sourcing: "Sourcing agent",
  support: "Support agent",
  treasury: "Treasury agent",
};

/** Mandate letter used in the UI and in approvals (S, R, T). */
export const ROLE_MANDATE: Record<Role, "S" | "R" | "T"> = { sourcing: "S", support: "R", treasury: "T" };

export type Address = `0x${string}`;

export interface Payee {
  address: Address;
  name?: string;
  website?: string;
}

/** Terms a mandate credential carries. `payees: null` means any payee. */
export interface MandateTerms {
  cap: Cents;
  budget: Cents;
  payees: Payee[] | null;
  description?: string;
}

export interface MandateStatus {
  mandateId: string;
  bound: boolean;
  revoked: boolean;
  spent: Cents;
  budget: Cents;
  cap: Cents;
  payees: Address[] | null;
  payments: number;
}

export type Mode = "offline" | "live";

/** Refusal codes the owner account returns when a payment falls outside a mandate. */
export const MANDATE_REFUSALS = [
  "mandate_payee_not_listed",
  "mandate_cap_exceeded",
  "mandate_budget_spent",
  "mandate_occurrences_used",
  "mandate_outside_recurrence",
  "mandate_expired",
  "mandate_revoked",
  "mandate_not_bound",
  "mandate_bad_signature",
  "mandate_outside_window",
  "mandate_nonce_used",
  "transfer_would_fail",
] as const;
export type MandateRefusal = (typeof MANDATE_REFUSALS)[number];

export class QmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "QmError";
  }
}
