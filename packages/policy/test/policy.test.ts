import { describe, expect, it } from "vitest";
import { KIT, type Address } from "@qm/core";
import {
  approvalHash,
  approvalRecord,
  checkInvariants,
  deltaFor,
  enumerateOptions,
  executionOrder,
  fallbackChoice,
  initialAllocation,
  invoiceRequiredUsd,
  recheckApproval,
  signApproval,
  validateChoice,
  verifyApproval,
  type PlanState,
} from "../src";

const FEED_A = "0x00000000000000000000000000000000000000a1" as Address;
const FEED_B = "0x00000000000000000000000000000000000000b2" as Address;

function kitState(overrides: Partial<PlanState> = {}): PlanState {
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

describe("initial allocation", () => {
  it("reproduces the kit split of 10 / 4 / 6 from first principles", () => {
    const s = kitState();
    expect(invoiceRequiredUsd(s)).toBe(572n);
    const { allocation, explanation } = initialAllocation(KIT.initialPlan, s, 2n);
    expect(allocation.treasury.budget).toBe(600n);
    expect(allocation.support.budget).toBe(400n);
    expect(allocation.sourcing.budget).toBe(1000n);
    expect(explanation.join(" ")).toMatch(/500 calls/);
  });
});

describe("invariants", () => {
  it("hold for the kit state before the spike", () => {
    expect(checkInvariants(kitState()).every((r) => r.ok)).toBe(true);
  });

  it("flag a budget sum above the allocation and a cap above the margin", () => {
    const s = kitState();
    const bad = { ...s.roles, sourcing: { ...s.roles.sourcing, budget: 1100n, cap: 5n } };
    const r = checkInvariants(s, bad);
    expect(r.find((x) => x.id === "I1")!.ok).toBe(false);
    expect(r.find((x) => x.id === "I4")!.ok).toBe(false);
  });
});

describe("price spike options", () => {
  it("sizes delta to keep two hours of runway", () => {
    // 4c × 120/h × 2h = 9.60 needed, 9.40 left → 0.20 short, + 10 headroom calls × 4c = 0.60
    expect(deltaFor(kitState(), 4n)).toBe(60n);
  });

  it("enumerates A–E and picks B: refunds can fund it, treasury cannot", () => {
    const opts = enumerateOptions(kitState());
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));
    expect(opts.map((o) => o.id)).toEqual(["A", "B", "C", "D", "E"]);
    expect(byId.A!.feasible).toBe(false);
    expect(byId.A!.reasons[0]).toMatch(/Feed B asks 0.05 USDZ, above cap S 0.03 USDZ and above the 0.04 USDZ margin limit/);
    expect(byId.B!.feasible).toBe(true);
    expect(byId.B!.needsApproval).toBe(true);
    expect(byId.B!.approvalReasons[0]).toMatch(/cap S rises 33%/);
    expect(byId.C!.feasible).toBe(false);
    expect(byId.C!.reasons[0]).toMatch(/licence fee 0.32 USDZ \(6%\) short/);
    expect(byId.D!.feasible).toBe(false);
    expect(byId.E!.feasible).toBe(true);

    const pick = fallbackChoice(opts);
    expect(pick.id).toBe("B");
    expect(pick.changes.map((c) => [c.role, c.new.cap, c.new.budget])).toEqual([
      ["support", 10n, 340n],
      ["sourcing", 4n, 1060n],
    ]);
    // Σ budgets stays 20.00 after the move.
    expect(pick.invariantsAfter.every((r) => r.ok)).toBe(true);
  });

  it("switches supplier with no mandate change when one is within the cap", () => {
    const s = kitState();
    s.suppliers[1]!.price = 3n;
    const pick = fallbackChoice(enumerateOptions(s));
    expect(pick.id).toBe("A");
    expect(pick.changes).toEqual([]);
    expect(pick.needsApproval).toBe(false);
  });

  it("falls back to E when nothing else can work", () => {
    const s = kitState({ trigger: { supplier: "A", price: 5n, offerHeaderSha256: "x" } });
    s.suppliers[1]!.price = 6n;
    expect(fallbackChoice(enumerateOptions(s)).id).toBe("E");
  });

  it("orders the donor before the receiver", () => {
    const pick = fallbackChoice(enumerateOptions(kitState()));
    const reordered = executionOrder([...pick.changes].reverse());
    expect(reordered.map((c) => c.role)).toEqual(["support", "sourcing"]);
  });
});

describe("planner validation", () => {
  const opts = enumerateOptions(kitState());

  it("accepts a pick whose numbers match the computed ones", () => {
    const v = validateChoice(opts, { option: "B", delta_usdz_cents: "60", new_sourcing_cap_cents: "4", ranking: ["B", "E"], explanation: "B keeps margin", rejected: [] });
    expect(v.source).toBe("planner");
    expect(v.option.id).toBe("B");
  });

  it("overrides a pick with invented numbers or an infeasible option", () => {
    expect(validateChoice(opts, { option: "B", delta_usdz_cents: "500", new_sourcing_cap_cents: "4", ranking: [], explanation: "", rejected: [] }).source).toBe("fallback");
    expect(validateChoice(opts, { option: "C", delta_usdz_cents: "60", new_sourcing_cap_cents: "4", ranking: [], explanation: "", rejected: [] }).source).toBe("fallback");
    expect(validateChoice(opts, undefined).option.id).toBe("B");
  });
});

describe("approval binding", () => {
  const secret = "test-secret";
  const s = kitState();
  const opt = fallbackChoice(enumerateOptions(s));
  const expires = new Date(Date.now() + 60_000).toISOString();
  const rec = approvalRecord(s, opt, "plan_1", "B keeps the margin", expires);

  it("signs and verifies an approval bound to the record hash", () => {
    const a = signApproval(secret, approvalHash(rec), "founder");
    expect(verifyApproval(secret, a)).toBe(true);
    expect(verifyApproval(secret, { ...a, hash: "0".repeat(64) })).toBe(false);
  });

  it("refuses when the price, balance or a mandate drifts, or the approval expires", () => {
    expect(recheckApproval(rec, approvalRecord(s, opt, "plan_1", "B keeps the margin", expires)).ok).toBe(true);

    const moved = kitState({ trigger: { ...s.trigger!, price: 5n } });
    const r1 = recheckApproval(rec, approvalRecord(moved, opt, "plan_1", "B keeps the margin", expires));
    expect(r1.ok).toBe(false);
    expect(r1.drift.join()).toMatch(/offer_price_cents/);

    const richer = kitState({ balance: s.balance + 5n });
    expect(recheckApproval(rec, approvalRecord(richer, opt, "plan_1", "B keeps the margin", expires)).drift.join()).toMatch(/balance_cents/);

    const old = approvalRecord(s, opt, "plan_1", "B keeps the margin", new Date(Date.now() - 1000).toISOString());
    expect(recheckApproval(old, old).drift).toContain("approval expired");
  });
});
