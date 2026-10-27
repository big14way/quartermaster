import { describe, expect, it } from "vitest";
import { ACCOUNTS, DocStore, Ledger, postings } from "../src";

describe("ledger", () => {
  it("posts balanced entries and keeps a per-currency trial balance at zero", () => {
    const l = new Ledger();
    l.post(postings.funding("0xfund", 2000n));
    l.post(postings.sale("set_1", 5n));
    l.post(postings.sourcing("0xs1", 2n));
    l.post(postings.refund("0xr1", 5n));
    l.post(postings.sweep("0xsw", 570n));
    l.post(postings.depositSettled("dep_1", 570n));
    l.post(postings.invoiceBooked("LIC", 500n));
    l.post(postings.conversion("cv_1", 559n, 515n));
    l.post(postings.transferPaid("tr_1", 500n, 15n));

    expect(l.balance(ACCOUNTS.metalAccount, "USDZ")).toBe(2000n + 5n - 2n - 5n - 570n);
    expect(l.balance(ACCOUNTS.awxUSD, "USD")).toBe(570n - 559n);
    expect(l.balance(ACCOUNTS.awxEUR, "EUR")).toBe(0n);
    expect(l.balance(ACCOUNTS.licencePayable, "EUR")).toBe(0n);
    expect(l.balance(ACCOUNTS.rampInTransit, "USDZ")).toBe(0n);

    const perCcy = new Map<string, bigint>();
    for (const row of l.trialBalance()) perCcy.set(row.currency, (perCcy.get(row.currency) ?? 0n) + row.balance);
    for (const total of perCcy.values()) expect(total).toBe(0n);
  });

  it("ignores a second post of the same external effect", () => {
    const l = new Ledger();
    expect(l.post(postings.sale("set_1", 5n)).posted).toBe(true);
    expect(l.post(postings.sale("set_1", 5n)).posted).toBe(false);
    expect(l.balance(ACCOUNTS.sales, "USDZ")).toBe(-5n);
  });

  it("rejects unbalanced entries and non-bigint amounts", () => {
    const l = new Ledger();
    expect(() =>
      l.post({
        source: "x",
        externalId: "1",
        memo: "bad",
        lines: [
          { account: "a", currency: "USD", amount: 5n },
          { account: "b", currency: "USD", amount: -4n },
        ],
      }),
    ).toThrow(/off by 1 USD/);
    expect(() =>
      l.post({ source: "x", externalId: "2", memo: "bad", lines: [{ account: "a", currency: "USD", amount: 1 as unknown as bigint }] }),
    ).toThrow(/bigint/);
  });
});

describe("doc store", () => {
  it("creates once and updates in place", () => {
    const d = new DocStore();
    expect(d.create("sales", "s1", { price: 5n })).toBe(true);
    expect(d.create("sales", "s1", { price: 6n })).toBe(false);
    expect(d.get<{ price: string }>("sales", "s1")!.price).toBe("5");
    d.update<{ price: string; refunded?: boolean }>("sales", "s1", (s) => ({ ...s!, refunded: true }));
    expect(d.list("sales")).toEqual([{ price: "5", refunded: true }]);
  });
});
