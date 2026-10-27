import { describe, expect, it } from "vitest";
import { enumerateOptions, type PlannerChoice } from "@qm/policy";
import { kitState } from "../../policy/test/fixtures";
import { claimByRules, invoiceByRules, planWithClaude } from "../src";

const INVOICE = `From: Nordlicht Data GmbH
Torstrasse 140, 10119 Berlin, Germany

Invoice no. LIC-2026-11
Market data redistribution licence, November 2026

Total due: EUR 5.00
Due date: 2026-10-31
IBAN: DE89 3704 0044 0532 0130 00
BIC: COBADEFFXXX
Reference: LIC-2026-11`;

describe("rule-based extraction", () => {
  it("reads the licence invoice fields", () => {
    expect(invoiceByRules(INVOICE)).toEqual({
      invoice_id: "LIC-2026-11",
      vendor: "Nordlicht Data GmbH",
      currency: "EUR",
      amount: "5.00",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      due_date: "2026-10-31",
      payment_reference: "LIC-2026-11",
    });
  });

  it("reads a dispute claim", () => {
    const tx = `0x${"ab".repeat(32)}`;
    const c = claimByRules(`These charges returned stale EURUSD quotes: ${tx}, stl_cd34 and ${tx} again.`);
    expect(c.charges).toEqual([tx, "stl_cd34"]);
    expect(c.claimed_issue).toBe("stale_data");
  });
});

describe("planner recording", () => {
  it("records the input when no key is set, and replays a recorded choice for the same input", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const state = kitState();
      const options = enumerateOptions(state);
      const hashes: string[] = [];
      const first = await planWithClaude(state, options, { lookup: () => undefined, record: (e) => void hashes.push(e.inputHash) });
      expect(first.source).toBe("unavailable");
      expect(hashes).toHaveLength(1);

      const choice: PlannerChoice = { option: "B", delta_usdz_cents: "60", new_sourcing_cap_cents: "4", ranking: ["B", "E", "C", "A", "D"], explanation: "x", rejected: [] };
      const replay = await planWithClaude(state, options, {
        lookup: (kind, hash) => (kind === "planner" && hash === hashes[0] ? choice : undefined),
        record: () => {},
      });
      expect(replay).toMatchObject({ source: "replay", choice: { option: "B" } });
    } finally {
      if (prev) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
