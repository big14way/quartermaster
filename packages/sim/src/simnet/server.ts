import express, { type NextFunction, type Request, type Response } from "express";
import { QmError, toJson, toCents, fromCents, baseUnitsToCents } from "@qm/core";
import { SIM_ASSET, SIM_NETWORK, SimChain, type OwnerAuth, type SimCredential, type SimPayment } from "./chain";
import type { PublicJwk } from "./keys";

function send(res: Response, status: number, body: unknown) {
  res.status(status).type("application/json").send(toJson(body));
}

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof QmError) send(res, 400, { code: err.code, message: err.message, details: err.details });
      else next(err);
    }
  };

/**
 * HTTP face of the simnet: owner operations, the account's pull, a faucet, a facilitator
 * with Metal's /verify, /settle and /settlements, and a tiny explorer. Labelled SIMULATED.
 */
export function simnetApp(chain: SimChain) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => send(res, 200, { ok: true, network: SIM_NETWORK, block: chain.block, simulated: true }));

  app.post("/faucet", wrap((req) => {
    const amount = toCents(String(req.body.amount ?? "100"));
    const tx = chain.faucet(req.body.address, amount);
    return { funded: fromCents(amount), transaction: tx.hash };
  }));

  app.post("/transfer", wrap((req) => {
    // Key-held transfers are authorised by the caller's own process in the simnet.
    const tx = chain.transfer(req.body.from, req.body.to, toCents(String(req.body.amount)));
    return { transaction: tx.hash };
  }));

  app.get("/balance/:address", wrap((req) => ({ address: req.params.address, usdz: fromCents(chain.balanceOf(String(req.params.address))) })));

  app.post("/account/create", wrap((req) => {
    const { account, tx } = chain.createAccount(req.body.ownerKey as PublicJwk);
    return { account: account.address, owner: account.owner, transaction: tx?.hash, existing: !tx };
  }));

  app.post("/mandate/bind", wrap((req) => {
    const tx = chain.bind(req.body.credential as SimCredential, req.body.auth as OwnerAuth);
    return { bound: req.body.credential.mandateId, transaction: tx.hash };
  }));

  app.post("/mandate/replace", wrap((req) => {
    const { tx, spent } = chain.replace(req.body.credential as SimCredential, req.body.replaces as string, req.body.auth as OwnerAuth, !!req.body.renew);
    return { replaced: req.body.replaces, bound: req.body.credential.mandateId, spent: fromCents(spent), transaction: tx.hash };
  }));

  app.post("/mandate/revoke", wrap((req) => {
    const tx = chain.revoke(req.body.mandateId as string, req.body.auth as OwnerAuth);
    return { revoked: req.body.mandateId, transaction: tx.hash };
  }));

  app.get("/mandate/:id", wrap((req) => {
    const m = chain.mandate(String(req.params.id));
    if (!m) throw new QmError("mandate_not_bound", "no such mandate");
    return {
      mandate: m.mandateId,
      principal: m.credential.principal,
      terms: m.credential.terms,
      mandateKey: m.credential.mandateKey,
      bound: true,
      revoked: m.revoked,
      successor: m.successor,
      spent: fromCents(baseUnitsToCents(BigInt(m.spent))),
      payments: m.payments.length,
      refusals: m.refusals.length,
      boundTx: m.boundTx,
    };
  }));

  app.post("/mandate/pull", wrap((req) => {
    const r = chain.pull(req.body.payment as SimPayment, {
      paymentId: req.body.paymentId,
      recordRefusal: !!req.body.recordRefusal,
      submitter: req.body.submitter,
    });
    if (r.outcome === "paid") {
      return {
        outcome: "paid",
        transaction: r.tx.hash,
        spent: fromCents(r.spent),
        budget: fromCents(r.budget),
        payee: r.tx.to,
        amount: fromCents(baseUnitsToCents(BigInt(r.tx.amount!))),
        repeated: r.repeated,
      };
    }
    return { outcome: "refused", reason: r.reason, recorded: r.recorded, transaction: r.tx?.hash };
  }));

  app.post("/mandate/verify", wrap((req) => chain.verify(req.body.credential as SimCredential, req.body.issuers as PublicJwk[], { tx: req.body.tx, signedOffer: req.body.signedOffer })));

  app.post("/mandate/verify-payment", wrap((req) => chain.verifyPayment(String(req.body.tx), String(req.body.signedOffer ?? ""))));

  app.post("/admin/fault", wrap((req) => {
    chain.setFault(req.body ?? {});
    return { ok: true };
  }));

  // ---- facilitator (same paths Metal's facilitator serves) ----------------------------

  const fac = express.Router();
  fac.get("/supported", (_req, res) => send(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: SIM_NETWORK }], simulated: true }));
  fac.post("/verify", wrap((req) => {
    const p = req.body.paymentPayload?.payload?.authorization as SimPayment | undefined;
    if (!p) return { isValid: false, invalidReason: "invalid_payload" };
    return chain.facilitatorVerify(p, req.body.paymentRequirements);
  }));
  fac.post("/settle", wrap((req) => {
    const p = req.body.paymentPayload?.payload?.authorization as SimPayment | undefined;
    if (!p) return { success: false, errorReason: "invalid_payload" };
    return chain.facilitatorSettle(p, req.body.paymentRequirements);
  }));
  fac.get("/settlements", wrap((req) => ({
    settlements: chain.settlements(String(req.query.payTo ?? ""), Number(req.query.since ?? 0)),
  })));
  app.use("/x402/facilitator", fac);

  // ---- explorer ---------------------------------------------------------------------

  app.get("/tx/:hash", (req, res) => {
    const tx = chain.tx(String(req.params.hash));
    if (!tx) return send(res, 404, { code: "not_found" });
    if (req.accepts(["html", "json"]) === "json") return send(res, 200, tx);
    const amount = tx.amount ? `${fromCents(baseUnitsToCents(BigInt(tx.amount)))} USDZ` : "";
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Simnet tx</title>
<body style="font:14px ui-monospace,monospace;background:#0b0d10;color:#e6e8eb;padding:24px">
<p style="color:#f5a524">SIMULATED · Quartermaster simnet (chain ${SIM_NETWORK}, asset ${SIM_ASSET})</p>
<h2>${tx.kind}${tx.reason ? ` · ${tx.reason}` : ""}</h2>
<table>${Object.entries({ hash: tx.hash, block: tx.block, from: tx.from, to: tx.to, amount, mandate: tx.mandateId, submitter: tx.submitter, at: new Date(tx.at).toISOString() })
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><td style="color:#8b949e;padding-right:16px">${k}</td><td>${v}</td></tr>`)
      .join("")}</table></body>`);
  });

  return app;
}
