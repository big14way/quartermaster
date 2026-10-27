import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { KIT, logger, mode, optionalEnv, port, toCents, usdz, varDir, type Address, type Cents, type Service } from "@qm/core";
import { LiveMetal } from "@qm/metal";
import { jsonApp, paywall, report, requireInternal, route, serve, LIVE_FACILITATOR } from "@qm/runtime";
import { randomAddress, writeJson } from "@qm/sim";

// Two upstream market-data sellers, each its own x402 business with its own payee
// address. The admin endpoints exist to drive the demo's price spike.

interface FeedState {
  id: "A" | "B";
  name: string;
  payTo: Address;
  price: Cents;
  degraded: boolean;
  calls: number;
}

const BASE: Record<string, number> = { EURUSD: 1.085, GBPUSD: 1.27, USDJPY: 151.2, XAUUSD: 2385, BTCUSD: 67250 };

async function payee(id: string): Promise<Address> {
  const fromEnv = optionalEnv(`FEED_${id}_PAYTO`);
  if (fromEnv) return fromEnv as Address;
  const file = varDir("feeds", `feed-${id.toLowerCase()}.json`);
  if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { address: Address }).address;
  let address: Address;
  if (mode() === "offline") address = randomAddress();
  else {
    const cli = new LiveMetal({ rpcUrl: optionalEnv("METAL_RPC_URL") ?? "", facilitatorUrl: LIVE_FACILITATOR, home: varDir("feeds") });
    const r = await cli.run(["key", "create", "--out", varDir("feeds", `feed-${id.toLowerCase()}.key.json`)]);
    address = r.lines.get("address")![0] as Address;
  }
  writeJson(file, { address });
  return address;
}

function quote(symbol: string, degraded: boolean, feed: string) {
  const base = BASE[symbol] ?? 100;
  const t = Date.now() / 1000;
  // A deterministic wobble so different feeds and times give different but sane prices.
  const wobble = Math.sin(t / 37 + symbol.length + (feed === "A" ? 0 : 1.3)) * 0.0015;
  const mid = base * (1 + wobble);
  const spread = mid * 0.0001;
  const asOf = degraded ? Date.now() - 15 * 60_000 : Date.now();
  const digits = base > 100 ? 2 : 5;
  return {
    symbol,
    bid: (mid - spread).toFixed(digits),
    ask: (mid + spread).toFixed(digits),
    mid: mid.toFixed(digits),
    as_of: new Date(asOf).toISOString(),
    source: `feed-${feed.toLowerCase()}`,
    seq: createHash("sha256").update(`${feed}${symbol}${asOf}`).digest("hex").slice(0, 12),
  };
}

async function startFeed(id: "A" | "B", service: Service) {
  const log = logger(`feed-${id}`);
  const spec = KIT.feeds[id];
  const state: FeedState = { id, name: spec.name, payTo: await payee(id), price: spec.initialPrice, degraded: false, calls: 0 };
  const app = jsonApp();
  const pw = await paywall({ signedOrders: false });

  pw.mount(
    app,
    {
      method: "GET",
      path: "/quote",
      resource: "GET /quote",
      description: `${spec.name}: one market-data quote, paid per request`,
      payTo: state.payTo,
      price: () => state.price,
      signedOrder: false,
    },
    async (req) => {
      const symbol = String(req.query.symbol ?? "EURUSD").toUpperCase();
      state.calls += 1;
      return { status: 200, body: quote(symbol, state.degraded, id) };
    },
  );

  app.get("/info", route(() => ({ id, name: state.name, payTo: state.payTo, price: state.price.toString(), degraded: state.degraded, calls: state.calls, url: `http://127.0.0.1:${port(service)}` })));
  app.post("/admin/price", requireInternal, route((req) => {
    const old = state.price;
    state.price = toCents(String(req.body.price));
    log.info(`price ${usdz(old)} → ${usdz(state.price)}`);
    report(`feed-${id}`, "feed.price_changed", { feed: id, name: state.name, from: old, to: state.price });
    return { price: state.price.toString() };
  }));
  app.post("/admin/degrade", requireInternal, route((req) => {
    state.degraded = !!req.body.on;
    report(`feed-${id}`, "feed.quality_changed", { feed: id, name: state.name, degraded: state.degraded });
    return { degraded: state.degraded };
  }));
  serve(app, service, `feed-${id}`);
}

await startFeed("A", "feedA");
await startFeed("B", "feedB");
