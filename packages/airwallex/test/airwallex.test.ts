import { describe, expect, it } from "vitest";
import { nextTransferStatus, orientRate, parseLossless, sellNeeded, sellPerBuy, signWebhook, verifyWebhook } from "../src";

describe("fx orientation", () => {
  it("derives sell-per-buy from the committed amounts, not client_rate", () => {
    // EURUSD market convention: client_rate 1.0850 whether you buy EUR or sell it.
    const r = sellPerBuy({ sell_amount: "5.59", buy_amount: "5.15" });
    expect(r.toFixed(4)).toBe("1.0854");
  });

  it("orients a market-convention rate for either side", () => {
    const buyEur = orientRate({ rate: "1.0850", currency_pair: "EURUSD", sell_currency: "USD", buy_currency: "EUR" });
    expect(buyEur.toFixed(4)).toBe("1.0850");
    const buyUsd = orientRate({ rate: "1.0850", currency_pair: "EURUSD", sell_currency: "EUR", buy_currency: "USD" });
    expect(buyUsd.toFixed(4)).toBe("0.9217");
    expect(() => orientRate({ rate: "1", currency_pair: "GBPUSD", sell_currency: "USD", buy_currency: "EUR" })).toThrow();
  });

  it("rounds the sell amount up to a whole cent", () => {
    expect(sellNeeded(515n, orientRate({ rate: "1.0850", currency_pair: "EURUSD", sell_currency: "USD", buy_currency: "EUR" }))).toBe(559n);
  });

  it("keeps numbers as exact text", () => {
    const v = parseLossless<{ amount: string; n: string }>('{"amount": 0.1000000000000000055511151231257827, "n": 12}');
    expect(v.amount).toBe("0.1000000000000000055511151231257827");
    expect(v.n).toBe("12");
  });
});

describe("transfer status guard", () => {
  const at = (s: string, t: string) => ({ status: s as never, updated_at: t });

  it("only moves forward in rank", () => {
    expect(nextTransferStatus(at("SENT", "2"), at("PROCESSING", "3")).status).toBe("SENT");
    expect(nextTransferStatus(at("SENT", "2"), at("PAID", "1")).status).toBe("PAID");
  });

  it("lets FAILED override PAID, and ignores CANCELLED after FAILED", () => {
    const failed = nextTransferStatus(at("PAID", "2"), at("FAILED", "3"));
    expect(failed.status).toBe("FAILED");
    expect(nextTransferStatus(failed, at("CANCELLED", "4")).status).toBe("FAILED");
    expect(nextTransferStatus(failed, at("PAID", "5")).status).toBe("FAILED");
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1","name":"payout.transfer.paid"}';

  it("accepts a valid signature inside the window", () => {
    const ts = String(Date.now());
    expect(verifyWebhook(secret, { timestamp: ts, signature: signWebhook(secret, ts, body) }, body)).toEqual({ ok: true });
  });

  it("rejects tampered bodies, stale timestamps and missing headers", () => {
    const ts = String(Date.now());
    const sig = signWebhook(secret, ts, body);
    expect(verifyWebhook(secret, { timestamp: ts, signature: sig }, body.replace("paid", "sent"))).toMatchObject({ reason: "bad_signature" });
    const old = String(Date.now() - 6 * 60_000);
    expect(verifyWebhook(secret, { timestamp: old, signature: signWebhook(secret, old, body) }, body)).toMatchObject({ reason: "stale_timestamp" });
    expect(verifyWebhook(secret, {}, body)).toMatchObject({ reason: "missing_headers" });
  });
});
