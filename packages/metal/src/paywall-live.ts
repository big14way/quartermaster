import type { Express } from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { registerMetalScheme } from "@metalntwx/metal-pay";
import { SIGNED_OFFER_REQUIRED, mandateRefOf, requireSignedOffer, signedOfferOf } from "@metalntwx/metal-pay/mandates";
import { baseUnitsToCents, fromCents } from "@qm/core";
import { METAL_NETWORK } from "./rail";
import { DELIVERY_HEADER, type PaidRoute, type Paywall, type RouteHandler, type Sale } from "./paywall";

/**
 * Live paywall on Metal testnet: @x402/express with Metal's scheme, and the signed-order
 * check in front of the facilitator for routes that ask for one. The middleware settles
 * after the handler, so the sale hook runs in onAfterSettle and keys on settlement.first.
 */
export class LivePaywall implements Paywall {
  private readonly hooks: ((s: Sale) => Promise<void> | void)[] = [];
  private readonly server: x402ResourceServer;

  constructor(cfg: { facilitatorUrl: string; rpcUrl: string; signedOrders: boolean }) {
    const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
    let server = registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] });
    if (cfg.signedOrders) server = requireSignedOffer(server, { rpcUrl: cfg.rpcUrl });
    server.onAfterSettle(async (ctx) => {
      const settlement = ctx.result.extra?.["settlement"] as { id: string; first: boolean } | undefined;
      if (!ctx.result.success || !settlement) return;
      const transport = ctx.transportContext as { responseHeaders?: Record<string, string> } | undefined;
      const sale: Sale = {
        settlementId: settlement.id,
        first: settlement.first,
        tx: ctx.result.transaction,
        payer: ctx.result.payer ?? "",
        amount: baseUnitsToCents(ctx.requirements.amount, "up"),
        resource: String(ctx.requirements.extra?.["resource"] ?? ""),
        signedOffer: signedOfferOf(ctx.paymentPayload as never) || undefined,
        mandateId: mandateRefOf(ctx.paymentPayload as never) || undefined,
        deliveryId: transport?.responseHeaders?.[DELIVERY_HEADER],
      };
      for (const h of this.hooks) await h(sale);
    });
    this.server = server;
  }

  mount(app: Express, route: PaidRoute, handler: RouteHandler) {
    app.use(
      paymentMiddleware(
        {
          [`${route.method} ${route.path}`]: {
            accepts: {
              scheme: "exact",
              network: METAL_NETWORK,
              payTo: route.payTo,
              price: () => fromCents(route.price()),
              ...(route.signedOrder ? { extra: { ...SIGNED_OFFER_REQUIRED, resource: route.resource } } : {}),
            },
            description: route.description,
          },
        } as never,
        this.server,
      ),
    );
    const method = route.method === "GET" ? "get" : "post";
    app[method](route.path, async (req, res) => {
      const out = await handler(req);
      if (out.deliveryId) res.setHeader(DELIVERY_HEADER, out.deliveryId);
      res.status(out.status).json(out.body);
    });
  }

  onSale(fn: (s: Sale) => Promise<void> | void) {
    this.hooks.push(fn);
  }
}
