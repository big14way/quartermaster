import { KIT, type Address } from "@qm/core";
import type { PlanState } from "../src";

const FEED_A = "0x00000000000000000000000000000000000000a1" as Address;
const FEED_B = "0x00000000000000000000000000000000000000b2" as Address;

export function kitState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    roles: {
      sourcing: { role: "sourcing", mandateId: "0xS", cap: 3n, budget: 1000n, spent: 60n, payees: [FEED_A, FEED_B], revoked: false },
      support: { role: "support", mandateId: "0xR", cap: 10n, budget: 400n, spent: 5n, payees: null, revoked: false },
      treasury: { role: "treasury", mandateId: "0xT", cap: 600n, budget: 600n, spent: 0n, payees: ["0x00000000000000000000000000000000000000aa" as Address], revoked: false },
    },
    balance: 2000n + 150n - 60n - 5n,
    block: 42,
    suppliers: [
      { id: "A", name: "Feed A", address: FEED_A, price: 4n, listed: true, healthy: true },
      { id: "B", name: "Feed B", address: FEED_B, price: 5n, listed: true, healthy: true },
    ],
    currentSupplier: "A",
    trigger: { supplier: "A", price: 4n, offerHeaderSha256: "abc", refusal: { code: "mandate_cap_exceeded", tx: "0xrefusal" } },
    invoice: { id: KIT.licence.invoiceId, vendor: KIT.licence.vendor, currency: "EUR", amount: KIT.licence.amount, feeEstimate: KIT.fx.feeEstimate, dueAt: "2026-10-31T00:00:00Z", paid: false },
    usdPerEur: "1.088255",
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
    ...overrides,
  };
}
