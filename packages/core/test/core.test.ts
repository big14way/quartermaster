import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EventLog,
  assertRequestId,
  baseUnitsToCents,
  canonicalHash,
  canonicalJson,
  ceilTo,
  centsToBaseUnits,
  changeBps,
  fromCents,
  readEvents,
  requestIds,
  toCents,
  verifyChain,
} from "../src";

describe("money", () => {
  it("parses decimal strings to cents exactly", () => {
    expect(toCents("0.05")).toBe(5n);
    expect(toCents("20")).toBe(2000n);
    expect(toCents("12.5")).toBe(1250n);
    expect(toCents("-1.20")).toBe(-120n);
    expect(toCents("4.300")).toBe(430n);
  });

  it("refuses sub-cent amounts unless told how to round", () => {
    expect(() => toCents("0.055")).toThrow(/finer than a cent/);
    expect(toCents("0.051", "up")).toBe(6n);
    expect(toCents("0.059", "down")).toBe(5n);
    expect(toCents("0.055", "half-up")).toBe(6n);
    expect(toCents("0.054", "half-up")).toBe(5n);
  });

  it("formats cents with two decimals", () => {
    expect(fromCents(5n)).toBe("0.05");
    expect(fromCents(2000n)).toBe("20.00");
    expect(fromCents(-7n)).toBe("-0.07");
  });

  it("converts to and from 18-decimal base units at the Metal boundary", () => {
    expect(centsToBaseUnits(5n)).toBe(50_000_000_000_000_000n);
    expect(baseUnitsToCents("50000000000000000")).toBe(5n);
    expect(() => baseUnitsToCents(1n)).toThrow(/whole cent/);
  });

  it("rounds up to a step and measures change in basis points", () => {
    expect(ceilTo(51n, 10n)).toBe(60n);
    expect(ceilTo(60n, 10n)).toBe(60n);
    expect(changeBps(3n, 4n)).toBe(3333n);
  });
});

describe("canonical json", () => {
  it("is independent of key order and writes bigint as strings", () => {
    const a = canonicalJson({ b: 1n, a: { y: 2, x: [1, { d: 1, c: 2 }] } });
    const b = canonicalJson({ a: { x: [1, { c: 2, d: 1 }], y: 2 }, b: 1n });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":[1,{"c":2,"d":1}],"y":2},"b":"1"}');
    expect(canonicalHash({ a: 1, b: undefined })).toBe(canonicalHash({ a: 1 }));
  });
});

describe("request ids", () => {
  it("builds ids within the 47 character limit", () => {
    expect(requestIds.transfer("LIC-2026-11", 1)).toBe("qm:tr:LIC-2026-11:1");
    expect(() => assertRequestId("x".repeat(48))).toThrow(/limit is 47/);
  });
});

describe("event log", () => {
  it("chains events and detects tampering", () => {
    const file = join(mkdtempSync(join(tmpdir(), "qm-")), "run.jsonl");
    const log = new EventLog(file);
    log.append({ type: "a", actor: "test", data: { n: 1n } });
    log.append({ type: "b", actor: "test", data: { n: 2 } });
    log.append({ type: "c", actor: "test", data: {} });
    const events = readEvents(file);
    expect(verifyChain(events).ok).toBe(true);
    expect(events[0]!.data.n).toBe("1");

    const tampered = events.map((e) => ({ ...e }));
    tampered[1] = { ...tampered[1]!, data: { n: 3 } };
    const check = verifyChain(tampered);
    expect(check.ok).toBe(false);
    expect(check.brokenAt).toBe(2);

    const reopened = new EventLog(file);
    expect(reopened.head).toBe(log.head);
    expect(reopened.append({ type: "d", actor: "test", data: {} }).seq).toBe(4);
  });
});
