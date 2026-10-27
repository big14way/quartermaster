import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AirwallexClient, AirwallexError, beneficiaryId, sellPerBuy, verifyWebhook } from "@qm/airwallex";
import { AwxSim } from "../src";

const secret = "whsec_sim";
const received: { name: string; ok: boolean }[] = [];
const servers: { close(): void }[] = [];
let client: AirwallexClient;
let sim: AwxSim;

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    servers.push(s);
  });
}

beforeAll(async () => {
  const hook = express();
  hook.post("/wh", express.text({ type: "*/*" }), (req, res) => {
    const check = verifyWebhook(secret, { timestamp: req.header("x-timestamp"), signature: req.header("x-signature") }, req.body as string);
    received.push({ name: JSON.parse(req.body as string).name, ok: check.ok });
    res.sendStatus(200);
  });
  const hookUrl = await listen(hook);
  sim = new AwxSim({ webhookSecret: secret, webhookUrl: `${hookUrl}/wh` });
  const base = await listen(sim.app());
  client = new AirwallexClient({ baseUrl: base, clientId: "sim", apiKey: "sim" });
});

afterAll(() => servers.forEach((s) => s.close()));

describe("airwallex simulator through the real client", () => {
  it("lands a deposit by reference, converts with a MIN_1 quote, and pays once", async () => {
    const usd = await client.createGlobalAccount({ request_id: "qm:ga:USD:test", country_code: "US", currency: "USD", nick_name: "Earnings" });
    await expect(client.createGlobalAccount({ request_id: "qm:ga:USD:test", country_code: "US", currency: "USD", nick_name: "Earnings" })).rejects.toMatchObject({
      code: "duplicate_request_id",
    });

    const dep = await client.simulateDeposit({ global_account_id: usd.id, amount: "5.70", reference: "0xsweep" });
    expect(await client.findDepositByReference("0xsweep")).toMatchObject({ id: dep.id });
    await client.settleDeposit(dep.id);
    expect((await client.balances()).find((b) => b.currency === "USD")?.available_amount).toBe("5.70");

    const rate = await client.currentRate({ sell_currency: "USD", buy_currency: "EUR" });
    expect(rate.currency_pair).toBe("EURUSD");
    const quote = await client.createQuote({ sell_currency: "USD", buy_currency: "EUR", buy_amount: "5.15" });
    expect(sellPerBuy(quote).gt(1)).toBe(true);
    const conv = await client.createConversion({ request_id: "qm:cv:LIC:1", sell_currency: "USD", buy_currency: "EUR", buy_amount: "5.15", quote_id: quote.quote_id });
    expect(conv.reused).toBe(false);
    const again = await client.createConversion({ request_id: "qm:cv:LIC:1", sell_currency: "USD", buy_currency: "EUR", buy_amount: "5.15", quote_id: quote.quote_id });
    expect(again).toMatchObject({ reused: true, value: { conversion_id: conv.value.conversion_id } });

    const input = {
      nickname: "Nordlicht",
      transfer_methods: ["LOCAL"],
      beneficiary: {
        entity_type: "COMPANY" as const,
        company_name: "Nordlicht Data GmbH",
        address: { city: "Berlin", country_code: "DE", postcode: "10119", street_address: "Torstrasse 140" },
        bank_details: { account_currency: "EUR", account_name: "Nordlicht Data GmbH", bank_country_code: "DE", iban: "DE89370400440532013000", swift_code: "COBADEFFXXX" },
      },
    };
    await client.validateBeneficiary(input);
    const ben = await client.createBeneficiary(input);

    sim.setFaults({ requestPendingOnce: true });
    const tr = await client.createTransfer({
      request_id: "qm:tr:LIC:1",
      beneficiary_id: beneficiaryId(ben),
      source_currency: "EUR",
      transfer_currency: "EUR",
      transfer_amount: "5.00",
      transfer_method: "LOCAL",
      reference: "LIC-2026-11",
      reason: "professional_business_services",
    });
    expect(tr.value.fee_amount).toBe("0.15");
    // A crash after create: the retry with the same request_id finds the same transfer.
    const retry = await client.createTransfer({
      request_id: "qm:tr:LIC:1",
      beneficiary_id: beneficiaryId(ben),
      source_currency: "EUR",
      transfer_currency: "EUR",
      transfer_amount: "5.00",
      transfer_method: "LOCAL",
      reference: "LIC-2026-11",
      reason: "professional_business_services",
    });
    expect(retry).toMatchObject({ reused: true, value: { id: tr.value.id } });

    for (const s of ["PROCESSING", "SENT", "PAID"] as const) await client.simulateTransferTransition(tr.value.id, s);
    expect((await client.getTransfer(tr.value.id)).status).toBe("PAID");
    expect((await client.balances()).find((b) => b.currency === "EUR")?.available_amount).toBe("0.00");

    await expect(client.simulateTransferTransition(tr.value.id, "SENT")).rejects.toBeInstanceOf(AirwallexError);

    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBeGreaterThan(4);
    expect(received.every((r) => r.ok)).toBe(true);
    expect(received.map((r) => r.name)).toContain("payout.transfer.paid");
  });
});
