import type { Express } from "express";
import { QmError, canonicalHash, getJson, url, usdz, type Address, type Cents } from "@qm/core";
import { probeOffer } from "@qm/metal";
import { report, requireAccount, requireInternal, route } from "@qm/runtime";
import type { AgentContext } from "./common";

interface FeedInfo {
  id: "A" | "B";
  name: string;
  payTo: Address;
  url: string;
}

/**
 * The sourcing agent buys one upstream quote per sale under mandate S. It reads the live
 * 402 price on every request and never caches it. An offer above the cap is refused here
 * before signing; the first such refusal per price is also recorded on chain, so the
 * evidence is a transaction anyone can check.
 */
export function mountSourcing(app: Express, ctx: AgentContext) {
  let supplier: "A" | "B" = "A";
  let paused = false;
  const recorded = new Map<string, string | undefined>();
  /** Every upstream purchase this agent has booked, by tx hash. */
  const bought = new Set<string>();
  let feeds: FeedInfo[] | undefined;

  async function feedList(): Promise<FeedInfo[]> {
    if (!feeds) feeds = [await getJson<FeedInfo>(`${url("feedA")}/info`), await getJson<FeedInfo>(`${url("feedB")}/info`)];
    return feeds;
  }

  async function recordRefusal(feed: FeedInfo, price: Cents): Promise<string | undefined> {
    const key = `${feed.id}:${price}`;
    if (recorded.has(key)) return recorded.get(key);
    const out = await ctx.rail.pull({
      credentialPath: ctx.files.credential,
      mandateKeyPath: ctx.files.mandateKey,
      to: feed.payTo,
      amount: price,
      paymentId: `refusal:${feed.id}:${price}`,
      recordRefusalWithKey: ctx.gasKey(),
    });
    const tx = out.outcome === "refused" && out.recorded ? out.tx : undefined;
    recorded.set(key, tx);
    return tx;
  }

  app.post("/buy", requireInternal, route(async (req) => {
    const symbol = String(req.body.symbol ?? "EURUSD");
    if (paused) throw new QmError("sourcing_paused", "sourcing is paused pending a plan", { status: 409 });
    const feed = (await feedList()).find((f) => f.id === supplier)!;
    const target = `${feed.url}/quote?symbol=${encodeURIComponent(symbol)}`;
    const probe = await probeOffer(target);
    const offer = probe.offer;
    if (!offer) throw new QmError("no_offer", `${feed.name} sent no exact USDZ offer`, { status: 502 });
    let status = await ctx.status();
    // Never refuse on a cached cap: confirm against the chain first.
    if (offer.price > status.cap) status = await ctx.status(true);
    const offerHash = canonicalHash(offer.requirement);

    if (offer.price > status.cap) {
      const firstTime = !recorded.has(`${feed.id}:${offer.price}`);
      const tx = await recordRefusal(feed, offer.price);
      report("sourcing", "sourcing.refused", {
        supplier: feed.id,
        name: feed.name,
        symbol,
        price: offer.price,
        cap: status.cap,
        code: "mandate_cap_exceeded",
        stage: firstTime ? "account" : "before-signing",
        tx,
        offerHash,
        mandateId: status.mandateId,
      });
      throw new QmError("mandate_cap_exceeded", `${feed.name} asks ${usdz(offer.price)}, above cap S ${usdz(status.cap)}`, {
        status: 409,
        supplier: feed.id,
        price: offer.price.toString(),
        cap: status.cap.toString(),
        tx,
      });
    }

    const startedAt = Date.now();
    const paid = await ctx.rail.payer(ctx.files.credential, ctx.files.mandateKey).pay(target);
    const secs = (Date.now() - startedAt) / 1000;
    if (secs > 20) ctx.log.warn(`paying ${feed.name} for ${symbol} took ${secs.toFixed(1)}s`);
    if (!paid.paid && paid.refusal?.stage === "in-doubt") {
      // A timeout is unconfirmed, not failed. Look the payment up before anything else; never pay again blind.
      const { account } = requireAccount();
      const rows = await ctx.rail.settlements(feed.payTo, startedAt - 2000);
      const nonce = paid.refusal.nonce;
      // Match by nonce when the facilitator reports it; otherwise the newest matching settlement we have not booked.
      const hit = nonce && rows.some((r) => r.nonce)
        ? rows.find((r) => r.nonce === nonce)
        : rows
            .filter((r) => r.payer.toLowerCase() === account.toLowerCase() && r.amount === offer.requirement.amount && !bought.has(r.transaction))
            .sort((a, b) => b.settledAt - a.settledAt)[0];
      report("sourcing", "sourcing.in_doubt", {
        supplier: feed.id,
        name: feed.name,
        symbol,
        settled: !!hit,
        tx: hit?.transaction,
        resolution: hit ? "found in /settlements: paid once, booked, not paid again" : "not settled: nothing was paid",
      });
      if (hit) {
        bought.add(hit.transaction);
        report("sourcing", "sourcing.bought", { supplier: feed.id, name: feed.name, symbol, tx: hit.transaction, amount: offer.price, payee: feed.payTo, inDoubt: true });
      }
      throw new QmError("settlement_in_doubt", "upstream payment was in doubt; no data delivered for this request", { status: 409 });
    }
    if (!paid.paid) {
      const code = paid.refusal?.code ?? "payment_failed";
      report("sourcing", "sourcing.refused", { supplier: feed.id, name: feed.name, symbol, price: offer.price, cap: status.cap, code, stage: paid.refusal?.stage, offerHash });
      throw new QmError(code, paid.refusal?.message ?? "purchase failed", { status: 409 });
    }
    bought.add(paid.paid.tx);
    report("sourcing", "sourcing.bought", { supplier: feed.id, name: feed.name, symbol, tx: paid.paid.tx, amount: paid.paid.amount, payee: paid.paid.payee, mandateId: paid.paid.mandateId });
    return { supplier: feed.id, name: feed.name, tx: paid.paid.tx, amount: paid.paid.amount, data: paid.body };
  }));

  app.get("/offers", route(async () => {
    const list = await feedList();
    return Promise.all(
      list.map(async (f) => {
        const p = await probeOffer(`${f.url}/quote?symbol=EURUSD`).catch(() => undefined);
        return { ...f, price: p?.offer?.price, offerHash: p?.offer ? canonicalHash(p.offer.requirement) : undefined, healthy: !!p?.offer };
      }),
    );
  }));

  app.get("/supplier", route(() => ({ supplier, paused })));
  app.post("/supplier", requireInternal, route((req) => {
    supplier = req.body.id === "B" ? "B" : "A";
    report("sourcing", "sourcing.supplier_switched", { supplier });
    return { supplier };
  }));
  app.post("/pause", requireInternal, route((req) => {
    paused = !!req.body.paused;
    report("sourcing", paused ? "sourcing.paused" : "sourcing.resumed", { reason: req.body.reason });
    return { paused };
  }));
}
