import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "@qm/core";
import { probeOffer } from "@qm/metal";
import { SimChain, SimMetal, SimPaywall, simnetApp } from "../src";

let base = "";
let dir = "";
let owner: SimMetal;
let account: Address;
const servers: { close(): void }[] = [];

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    servers.push(s);
  });
}

const FEED: Address = "0x00000000000000000000000000000000000feed1";
const OTHER: Address = "0x0000000000000000000000000000000000000bad";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "qm-simnet-"));
  base = await listen(simnetApp(new SimChain()));
  owner = new SimMetal({ simnetUrl: base, ownerKeyFile: join(dir, "owner-key.json") });
  account = (await owner.createAccount()).account;
  await owner.fund(account, 2000n);
});

afterAll(() => servers.forEach((s) => s.close()));

describe("simnet mandates", () => {
  it("enforces payee, cap and budget with Metal's refusal codes", async () => {
    const c = await owner.createCredential({ principal: account, terms: { cap: 3n, budget: 5n, payees: [{ address: FEED, name: "Feed A" }] }, out: join(dir, "s.json") });
    await owner.bind(c.credentialPath);
    const agent = new SimMetal({ simnetUrl: base });

    const ok = await agent.pull({ credentialPath: c.credentialPath, mandateKeyPath: c.mandateKeyPath, to: FEED, amount: 3n, paymentId: "p1" });
    expect(ok).toMatchObject({ outcome: "paid", spent: 3n, budget: 5n });

    const again = await agent.pull({ credentialPath: c.credentialPath, mandateKeyPath: c.mandateKeyPath, to: FEED, amount: 3n, paymentId: "p1" });
    expect(again).toMatchObject({ outcome: "paid", repeated: true, spent: 3n });

    expect(await agent.pull({ credentialPath: c.credentialPath, mandateKeyPath: c.mandateKeyPath, to: OTHER, amount: 1n, paymentId: "p2" })).toMatchObject({
      outcome: "refused",
      reason: "mandate_payee_not_listed",
    });
    expect(await agent.pull({ credentialPath: c.credentialPath, mandateKeyPath: c.mandateKeyPath, to: FEED, amount: 4n, paymentId: "p3", recordRefusalWithKey: "gas.json" })).toMatchObject({
      outcome: "refused",
      reason: "mandate_cap_exceeded",
      recorded: true,
    });
    expect(await agent.pull({ credentialPath: c.credentialPath, mandateKeyPath: c.mandateKeyPath, to: FEED, amount: 3n, paymentId: "p4" })).toMatchObject({
      outcome: "refused",
      reason: "mandate_budget_spent",
    });

    const status = await agent.status(c.credentialPath);
    expect(status).toMatchObject({ bound: true, revoked: false, spent: 3n, budget: 5n, cap: 3n, payments: 1 });

    const report = await agent.verify({ credentialPath: c.credentialPath, issuerPublicPaths: [c.issuerPublicPath] });
    expect(report.verified).toBe(true);
    expect(report.payments.map((p) => p.kind)).toEqual(["payment", "refusal"]);
  });

  it("replaces a mandate carrying spend over, and refuses the old credential", async () => {
    const c1 = await owner.createCredential({ principal: account, terms: { cap: 3n, budget: 100n, payees: null }, out: join(dir, "r1.json") });
    await owner.bind(c1.credentialPath);
    const agent = new SimMetal({ simnetUrl: base });
    await agent.pull({ credentialPath: c1.credentialPath, mandateKeyPath: c1.mandateKeyPath, to: OTHER, amount: 3n, paymentId: "x1" });

    const tooSmall = await owner.createCredential({ principal: account, terms: { cap: 4n, budget: 2n, payees: null }, out: join(dir, "r-small.json"), mandateKeyFile: c1.mandateKeyPath });
    await expect(owner.replace(tooSmall.credentialPath, c1.credentialPath)).rejects.toThrow(/mandate_budget_below_spent/);

    const c2 = await owner.createCredential({ principal: account, terms: { cap: 4n, budget: 80n, payees: null }, out: join(dir, "r2.json"), mandateKeyFile: c1.mandateKeyPath });
    const rep = await owner.replace(c2.credentialPath, c1.credentialPath);
    expect(rep.spent).toBe(3n);

    expect(await agent.pull({ credentialPath: c1.credentialPath, mandateKeyPath: c1.mandateKeyPath, to: OTHER, amount: 1n, paymentId: "x2" })).toMatchObject({
      outcome: "refused",
      reason: "mandate_revoked",
    });
    expect(await agent.pull({ credentialPath: c2.credentialPath, mandateKeyPath: c2.mandateKeyPath, to: OTHER, amount: 4n, paymentId: "x3" })).toMatchObject({
      outcome: "paid",
      spent: 7n,
      budget: 80n,
    });
  });
});

describe("simnet x402", () => {
  it("settles a paid route once, after the handler, with a signed order", async () => {
    const seller = new SimMetal({ simnetUrl: base, ownerKeyFile: join(dir, "seller-key.json") });
    const sellerAcct = (await seller.createAccount()).account;
    const paywall = new SimPaywall({ simnetUrl: base });
    const sales: unknown[] = [];
    paywall.onSale((s) => void sales.push(s));
    let fail = false;
    const app = express();
    paywall.mount(
      app,
      { method: "GET", path: "/q", resource: "GET /q", description: "test", payTo: sellerAcct, price: () => 5n, signedOrder: true },
      async () => (fail ? { status: 503, body: { error: "upstream" } } : { status: 200, body: { ok: true }, deliveryId: "d1" }),
    );
    const url = await listen(app);

    const probe = await probeOffer(`${url}/q`);
    expect(probe.status).toBe(402);
    expect(probe.offer).toMatchObject({ price: 5n, signedOrderRequired: true, resource: "GET /q" });

    const buyerCred = await owner.createCredential({ principal: account, terms: { cap: 10n, budget: 50n, payees: [{ address: sellerAcct }] }, out: join(dir, "buyer.json") });
    await owner.bind(buyerCred.credentialPath);
    const buyer = new SimMetal({ simnetUrl: base }).payer(buyerCred.credentialPath, buyerCred.mandateKeyPath);

    const paid = await buyer.pay(`${url}/q`);
    expect(paid.status).toBe(200);
    expect(paid.paid?.amount).toBe(5n);
    expect(paid.paid?.signedOffer).toMatch(/^qmso1\./);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ first: true, amount: 5n, deliveryId: "d1" });

    fail = true;
    const notCharged = await buyer.pay(`${url}/q`);
    expect(notCharged.status).toBe(503);
    expect(notCharged.paid).toBeUndefined();
    expect(sales).toHaveLength(1);

    const rows = await seller.settlements(sellerAcct);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transaction).toBe(paid.paid!.tx);

    const v = await owner.verify({ credentialPath: buyerCred.credentialPath, issuerPublicPaths: [buyerCred.issuerPublicPath], tx: paid.paid!.tx, signedOffer: paid.paid!.signedOffer });
    expect(v.verified).toBe(true);
  });
});
