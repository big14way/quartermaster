import type { Address, Cents, Role } from "@qm/core";

export interface RoleState {
  role: Role;
  mandateId: string;
  cap: Cents;
  budget: Cents;
  spent: Cents;
  payees: Address[] | null;
  revoked: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  address: Address;
  /** Live price from the supplier's latest 402. */
  price: Cents;
  /** Whether its address is on mandate S's payee list. */
  listed: boolean;
  healthy: boolean;
}

export interface Invoice {
  id: string;
  vendor: string;
  currency: "EUR";
  amount: Cents;
  feeEstimate: Cents;
  dueAt: string;
  paid: boolean;
}

export interface Forecast {
  callsPerHour: bigint;
  runwayHours: bigint;
  headroomCalls: bigint;
  refundsP95PerHour: bigint;
  maxPassThroughBps: bigint;
}

export interface PolicyLimits {
  totalAllocation: Cents;
  gasReserve: Cents;
  sellPrice: Cents;
  minMargin: Cents;
  fxBufferBps: bigint;
  capRiseBps: bigint;
  deltaThreshold: Cents;
}

/** Everything the policy engine needs, read from live state (chain, 402 offers, Airwallex). */
export interface PlanState {
  roles: Record<Role, RoleState>;
  /** USDZ balance of the owner account on chain, B. */
  balance: Cents;
  /** Block (or simnet block) the balance and mandate reads were taken at. */
  block: number;
  suppliers: Supplier[];
  currentSupplier: string;
  /** The offer that triggered the plan: the supplier, its price and the sha256 of its 402 header. */
  trigger?: { supplier: string; price: Cents; offerHeaderSha256: string; refusal?: { code: string; tx?: string } };
  invoice: Invoice;
  /** USD per one EUR, oriented from the live rate. Decimal string. */
  usdPerEur: string;
  forecast: Forecast;
  limits: PolicyLimits;
}

export type InvariantId = "I1" | "I2" | "I3" | "I4" | "I5";

export interface InvariantResult {
  id: InvariantId;
  ok: boolean;
  title: string;
  detail: string;
}

export interface Terms {
  cap: Cents;
  budget: Cents;
  payees: Address[] | null;
}

export interface MandateChange {
  role: Role;
  mandateId: string;
  old: Terms;
  new: Terms;
}

export type OptionId = "A" | "B" | "C" | "D" | "E";

export interface PlanOption {
  id: OptionId;
  title: string;
  feasible: boolean;
  /** Plain-language reasons it is infeasible, or notes when feasible. */
  reasons: string[];
  changes: MandateChange[];
  /** Budget moved from donor to sourcing, in cents. */
  delta: Cents;
  supplier?: string;
  /** What one sale earns after the input cost. */
  marginPerCall: Cents;
  /** Expected margin over the runway, used to rank feasible options. */
  marginOverRunway: Cents;
  donorSlackAfter?: Cents;
  invariantsAfter: InvariantResult[];
  needsApproval: boolean;
  approvalReasons: string[];
}
