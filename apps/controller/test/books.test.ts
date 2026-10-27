import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "@qm/core";
import { ACCOUNTS } from "@qm/ledger";
import { Books } from "../src/books";

let bus: EventLog;
let books: Books;

beforeEach(() => {
  process.env.QM_HOME = mkdtempSync(join(tmpdir(), "qm-books-"));
  bus = new EventLog();
  books = new Books(bus);
});

const transfer = (status: string, updated_at: string) => ({
  id: "tr_1",
  status,
  updated_at,
  transfer_amount: "5.00",
  fee_amount: "0.15",
  reference: "LIC-2026-11",
});

const webhook = (id: string, name: string, object: Record<string, string>) => ({ id, name, created_at: new Date().toISOString(), data: { object } });

describe("books from webhooks", () => {
  it("deduplicates by event id and ignores a late status", () => {
    books.ledger.post({
      source: "invoice:booked",
      externalId: "LIC",
      memo: "",
      lines: [
        { account: ACCOUNTS.licence, currency: "EUR", amount: 500n },
        { account: ACCOUNTS.licencePayable, currency: "EUR", amount: -500n },
      ],
    });
    books.onWebhook(webhook("evt_1", "payout.transfer.paid", transfer("PAID", "2026-10-27T10:00:03Z")));
    books.onWebhook(webhook("evt_1", "payout.transfer.paid", transfer("PAID", "2026-10-27T10:00:03Z")));
    books.onWebhook(webhook("evt_2", "payout.transfer.sent", transfer("SENT", "2026-10-27T10:00:02Z")));

    expect(books.transferStatus("tr_1")).toBe("PAID");
    expect(bus.events.filter((e) => e.type === "awx.webhook_duplicate")).toHaveLength(1);
    expect(bus.events.find((e) => e.type === "awx.transfer_status" && e.data.ignored)?.data.kept).toBe("PAID");
    expect(books.ledger.balance(ACCOUNTS.licencePayable, "EUR")).toBe(0n);
    expect(books.ledger.balance(ACCOUNTS.awxFees, "EUR")).toBe(15n);
  });

  it("reverses the payment on a FAILED after PAID, keeping the fee", () => {
    books.onWebhook(webhook("evt_1", "payout.transfer.paid", transfer("PAID", "2026-10-27T10:00:03Z")));
    books.onWebhook(webhook("evt_2", "payout.transfer.failed", transfer("FAILED", "2026-10-27T10:05:00Z")));
    expect(books.transferStatus("tr_1")).toBe("FAILED");
    expect(books.ledger.has("awx:transfer", "tr_1:reversed")).toBe(true);
    expect(books.ledger.balance(ACCOUNTS.awxFees, "EUR")).toBe(15n);
  });

  it("lands only deposits that reference a sweep tx, once, from webhook or poll", () => {
    books.ledger.post({
      source: "metal:sweep",
      externalId: "0xsweep",
      memo: "",
      lines: [
        { account: ACCOUNTS.rampInTransit, currency: "USDZ", amount: 572n },
        { account: ACCOUNTS.metalAccount, currency: "USDZ", amount: -572n },
      ],
    });
    const dep = { id: "dep_1", amount: "5.72", currency: "USD", reference: "0xsweep", status: "SETTLED" };
    books.onWebhook(webhook("evt_1", "deposit.settled", dep));
    books.foldSnapshot({ deposits: [dep], transfers: [], conversions: [] });
    books.onWebhook(webhook("evt_2", "deposit.settled", { ...dep, id: "dep_2", reference: "something else" }));

    expect(books.ledger.balance(ACCOUNTS.awxUSD, "USD")).toBe(572n);
    expect(books.ledger.balance(ACCOUNTS.rampInTransit, "USDZ")).toBe(0n);
    expect(bus.events.filter((e) => e.type === "awx.deposit_settled")).toHaveLength(1);
    expect(bus.events.filter((e) => e.type === "awx.deposit_unmatched")).toHaveLength(1);
  });
});
