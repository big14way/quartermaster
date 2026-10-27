import type { Express, Request, Response } from "express";
import { baseUnitsToCents, centsToBaseUnits, requestJson } from "@qm/core";
import {
  DELIVERY_HEADER,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  METAL_NETWORK,
  USDZ_ADDRESS,
  decodeHeader,
  encodeHeader,
  type PaidRoute,
  type Paywall,
  type Requirement,
  type RouteHandler,
  type Sale,
} from "@qm/metal";
import { decodeSignedOffer, type SimPayment } from "./chain";
import { verifyPayload, type PublicJwk } from "./keys";

interface PaymentPayload {
  x402Version: number;
  accepted: Requirement;
  payload: { authorization: SimPayment };
  extensions?: { "metal-mandate"?: { ref: string; checkoutMandate: string } };
}

/**
 * Offline paywall with the live one's behaviour: 402 with the same header, the signed
 * order checked before the facilitator, verify → handler → settle only on status < 400,
 * and one sale report per settlement with `first`.
 */
export class SimPaywall implements Paywall {
  private readonly hooks: ((s: Sale) => Promise<void> | void)[] = [];

  constructor(private readonly cfg: { simnetUrl: string }) {}

  private get facilitator() {
    return `${this.cfg.simnetUrl}/x402/facilitator`;
  }

  mount(app: Express, route: PaidRoute, handler: RouteHandler) {
    const method = route.method === "GET" ? "get" : "post";
    app[method](route.path, async (req: Request, res: Response) => {
      const requirement: Requirement = {
        scheme: "exact",
        network: METAL_NETWORK,
        amount: centsToBaseUnits(route.price()).toString(),
        asset: USDZ_ADDRESS,
        payTo: route.payTo,
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD Zero",
          version: "1",
          primaryType: "TransferWithAuthorization",
          ...(route.signedOrder ? { signedOffer: "required", resource: route.resource } : {}),
        },
      };
      const reject = (error: string) => {
        res
          .status(402)
          .set("cache-control", "no-store")
          .set(
            HEADER_REQUIRED,
            encodeHeader({ x402Version: 2, error, resource: { url: `${req.protocol}://${req.get("host")}${req.originalUrl}`, description: route.description, mimeType: "" }, accepts: [requirement] }),
          )
          .json({});
      };

      const payload = decodeHeader<PaymentPayload>(req.header(HEADER_SIGNATURE));
      if (!payload) return reject("Payment required");
      const auth = payload.payload?.authorization;
      if (!auth) return reject("invalid_payload");
      // The payment must match the offer served now; a price change since the 402 means re-quote.
      if (auth.amount !== requirement.amount) return reject("payment_mismatch:amount");
      if (auth.to.toLowerCase() !== route.payTo.toLowerCase()) return reject("payment_mismatch:payTo");

      const ext = payload.extensions?.["metal-mandate"];
      if (route.signedOrder) {
        const check = await this.checkSignedOffer(ext?.checkoutMandate, auth, route);
        if (check) return reject(check);
      }

      const v = await requestJson<{ isValid: boolean; invalidReason?: string }>(`${this.facilitator}/verify`, {
        body: { paymentPayload: payload, paymentRequirements: requirement },
      });
      if (!v.isValid) return reject(v.invalidReason ?? "payment_refused");

      const out = await handler(req);
      // A failed request is never charged: answer with the error and do not settle.
      if (out.status >= 400) return res.status(out.status).json(out.body);

      const s = await requestJson<{ success: boolean; transaction: string; payer: string; errorReason?: string; extra?: { settlement: { id: string; first: boolean } } }>(
        `${this.facilitator}/settle`,
        { body: { paymentPayload: payload, paymentRequirements: requirement } },
      );
      if (!s.success || !s.extra) return reject(s.errorReason ?? "payment_failed");

      const sale: Sale = {
        settlementId: s.extra.settlement.id,
        first: s.extra.settlement.first,
        tx: s.transaction,
        payer: s.payer,
        amount: baseUnitsToCents(requirement.amount),
        resource: route.resource,
        signedOffer: ext?.checkoutMandate || undefined,
        mandateId: ext?.ref,
        deliveryId: out.deliveryId,
      };
      for (const h of this.hooks) await h(sale);

      if (out.deliveryId) res.set(DELIVERY_HEADER, out.deliveryId);
      res
        .set(HEADER_RESPONSE, encodeHeader({ success: true, transaction: s.transaction, network: METAL_NETWORK, payer: s.payer }))
        .status(out.status)
        .json(out.body);
    });
  }

  /** The signed order must be the bound mandate key's, over this route's offer. */
  private async checkSignedOffer(text: string | undefined, auth: SimPayment, route: PaidRoute): Promise<string | undefined> {
    if (!text) return "signed_offer_required";
    const d = decodeSignedOffer(text);
    if (!d) return "signed_offer_unreadable";
    if (d.body.mandateId !== auth.mandateId) return "signed_offer_wrong_mandate";
    let mandate: { principal: string; mandateKey: PublicJwk; revoked: boolean };
    try {
      mandate = await requestJson(`${this.cfg.simnetUrl}/mandate/${auth.mandateId}`);
    } catch {
      return "signed_offer_mandate_not_bound";
    }
    if (mandate.revoked) return "mandate_revoked";
    if (mandate.principal.toLowerCase() !== auth.principal.toLowerCase()) return "signed_offer_wrong_principal";
    if (!verifyPayload(mandate.mandateKey, d.body, d.signature)) return "signed_offer_bad_signature";
    if (d.body.resource !== route.resource) return "signed_offer_wrong_resource";
    if (d.body.amount !== auth.amount || d.body.payTo.toLowerCase() !== route.payTo.toLowerCase()) return "signed_offer_wrong_terms";
    return undefined;
  }

  onSale(fn: (s: Sale) => Promise<void> | void) {
    this.hooks.push(fn);
  }
}
