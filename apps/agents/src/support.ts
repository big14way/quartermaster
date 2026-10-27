import type { Express } from "express";
import { QmError, fromCents, getJson, paymentIds, toCents, url, usdz, type Address, type Cents } from "@qm/core";
import { readClaim } from "@qm/planner";
import { randomAddress } from "@qm/sim";
import { report, requireInternal, route } from "@qm/runtime";
import type { AgentContext } from "./common";

interface SaleRecord {
  settlementId: string;
  tx: string;
  payer: string;
  amount: string;
  signedOffer?: string;
  refundTx?: string;
  delivery?: { id: string; symbol: string; quality: "ok" | "stale"; as_of: string; served_at: string; age_ms: number; supplier: string };
}

type Decision =
  | { settlementId: string; decision: "refunded"; amount: Cents; tx: string; why: string }
  | { settlementId: string; decision: "already_refunded"; tx: string; why: string }
  | { settlementId: string; decision: "rejected" | "escalated"; why: string; evidence?: Record<string, unknown> };

/**
 * The support agent refunds buyers under mandate R, which allows any payee but caps each
 * refund. Claims are read by a model; whether to refund is decided in code from the stored
 * signed order (proves price and route) and the delivery record (proves what was served).
 */
export function mountSupport(app: Express, ctx: AgentContext) {
  async function refund(settlementId: string, to: Address, amount: Cents, why: string) {
    const out = await ctx.rail.pull({ credentialPath: ctx.files.credential, mandateKeyPath: ctx.files.mandateKey, to, amount, paymentId: paymentIds.refund(settlementId) });
    if (out.outcome === "paid") {
      report("support", "refund.paid", { settlementId, to, amount, tx: out.tx, spent: out.spent, budget: out.budget, why, repeated: !!out.repeated });
      return out;
    }
    report("support", "refund.refused", { settlementId, to, amount, outcome: out.outcome, reason: "reason" in out ? out.reason : undefined });
    return out;
  }

  app.post("/refund", requireInternal, route(async (req) => {
    const out = await refund(String(req.body.settlementId), req.body.to as Address, toCents(String(req.body.amount)), String(req.body.why ?? "manual"));
    if (out.outcome !== "paid") throw new QmError(out.outcome === "refused" ? out.reason : out.outcome, "refund not paid", { status: 409 });
    return out;
  }));

  app.post("/disputes", requireInternal, route(async (req) => {
    const { claimId, buyer, principal, text } = req.body as { claimId: string; buyer: string; principal: Address; text: string };
    const claim = await readClaim(text, ctx.recorder);
    report("support", "dispute.read", { claimId, buyer, issue: claim.fields.claimed_issue, charges: claim.fields.charges, summary: claim.fields.summary, source: claim.source });
    const status = await ctx.status(true);
    const decisions: Decision[] = [];

    for (const ref of claim.fields.charges) {
      const sale = await getJson<SaleRecord>(`${url("seller")}/sales/${ref}`).catch(() => undefined);
      if (!sale) {
        decisions.push({ settlementId: ref, decision: "rejected", why: "no such charge in our sales records" });
        continue;
      }
      const id = sale.settlementId;
      if (sale.payer.toLowerCase() !== principal.toLowerCase()) {
        decisions.push({ settlementId: id, decision: "rejected", why: "the charge was paid by another account" });
        continue;
      }
      if (sale.refundTx) {
        decisions.push({ settlementId: id, decision: "already_refunded", tx: sale.refundTx, why: "refunded earlier" });
        continue;
      }
      if (!sale.signedOffer) {
        decisions.push({ settlementId: id, decision: "rejected", why: "no signed order stored for this charge" });
        continue;
      }
      const proof = await ctx.rail.verifyPayment({ tx: sale.tx, signedOffer: sale.signedOffer });
      if (!proof.verified) {
        decisions.push({ settlementId: id, decision: "rejected", why: "the signed order does not match the payment on chain", evidence: { steps: proof.steps } });
        continue;
      }
      const amount = toCents(sale.amount);
      const d = sale.delivery;
      if (!d || d.quality === "ok") {
        decisions.push({
          settlementId: id,
          decision: "rejected",
          why: d ? `the quote served was fresh: as of ${d.as_of}, ${Math.round(d.age_ms / 1000)}s old when delivered` : "delivery record missing",
          evidence: { signedOrder: "verified", delivery: d },
        });
        continue;
      }
      if (amount > status.cap) {
        decisions.push({ settlementId: id, decision: "escalated", why: `refund ${usdz(amount)} is above cap R ${usdz(status.cap)}` });
        continue;
      }
      const out = await refund(id, sale.payer as Address, amount, `stale data: as of ${d.as_of}, ${Math.round(d.age_ms / 60000)} min old when delivered`);
      if (out.outcome === "paid") decisions.push({ settlementId: id, decision: "refunded", amount, tx: out.tx, why: `signed order verified; quote was ${Math.round(d.age_ms / 60000)} min old` });
      else decisions.push({ settlementId: id, decision: "escalated", why: `refund not paid: ${out.outcome === "refused" ? out.reason : out.outcome}` });
    }
    const refunded = decisions.filter((x) => x.decision === "refunded");
    report("support", "dispute.resolved", {
      claimId,
      buyer,
      decisions,
      refundedCount: refunded.length,
      refundedTotal: fromCents(refunded.reduce((s, x) => s + (x.decision === "refunded" ? x.amount : 0n), 0n)),
    });
    return { claimId, decisions };
  }));

  /** The compromised-agent drill: a support agent trying to pay itself 10 USDZ is refused by the account. */
  app.post("/drill/self-refund", requireInternal, route(async (req) => {
    const to = (req.body.to as Address) ?? randomAddress();
    const amount = toCents(String(req.body.amount ?? "10.00"));
    const out = await ctx.rail.pull({
      credentialPath: ctx.files.credential,
      mandateKeyPath: ctx.files.mandateKey,
      to,
      amount,
      paymentId: `drill:${Date.now()}`,
      recordRefusalWithKey: ctx.files.gasKey,
    });
    report("support", out.outcome === "paid" ? "security.breach" : "security.refused", {
      attempt: `support agent tries to pay ${usdz(amount)} to ${to}`,
      outcome: out.outcome,
      reason: out.outcome === "refused" ? out.reason : undefined,
      tx: out.outcome === "refused" ? out.tx : out.outcome === "paid" ? out.tx : undefined,
    });
    return out;
  }));
}
