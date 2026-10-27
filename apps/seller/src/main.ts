import { createHmac } from "node:crypto";
import { KIT, QmError, canonicalHash, canonicalJson, env, fromCents, logger, newId, requestJson, sleep, toCents, url, usdz, varDir } from "@qm/core";
import { DocStore } from "@qm/ledger";
import { internalHeaders, jsonApp, paywall, readAccount, report, requireInternal, route, serve } from "@qm/runtime";

// Quartermaster's own paid API: GET /v1/snapshot?symbol=…, 5 cents a call, signed order
// required. Each sale is stored with its signed order, its transaction hash and what was
// delivered, because nothing else stores them. A request we cannot serve is answered with
// an error status, so the middleware never settles it.

const log = logger("seller");
const db = new DocStore(varDir("seller", "sales.sqlite"));
const SIGNING_KEY = env("QM_SELLER_SIGNING_KEY", "dev-seller-signing-key");
const STALE_MS = 60_000;
let price = KIT.sellPrice;

interface Delivery {
  id: string;
  symbol: string;
  supplier: string;
  upstreamTx: string;
  upstreamCost: string;
  as_of: string;
  served_at: string;
  age_ms: number;
  quality: "ok" | "stale";
  payloadHash: string;
}

interface SaleDoc {
  settlementId: string;
  tx: string;
  payer: string;
  amount: string;
  signedOffer?: string;
  mandateId?: string;
  deliveryId?: string;
  delivery?: Delivery;
  refundTx?: string;
  at: string;
}

const app = jsonApp();

async function mountWhenReady() {
  let account = readAccount();
  while (!account) {
    await sleep(500);
    account = readAccount();
  }
  const pw = await paywall({ signedOrders: true });
  pw.onSale(async (sale) => {
    if (!sale.first) {
      report("seller", "sale.repeat_settlement", { settlementId: sale.settlementId, tx: sale.tx });
      return;
    }
    const delivery = sale.deliveryId ? db.get<Delivery>("deliveries", sale.deliveryId) : undefined;
    const doc: SaleDoc = { ...sale, amount: fromCents(sale.amount), delivery, at: new Date().toISOString() };
    db.create("sales", sale.settlementId, doc);
    db.put("sales-by-tx", sale.tx.toLowerCase(), { settlementId: sale.settlementId });
    report("seller", "sale.settled", {
      settlementId: sale.settlementId,
      tx: sale.tx,
      payer: sale.payer,
      amount: sale.amount,
      mandateId: sale.mandateId,
      signedOffer: !!sale.signedOffer,
      symbol: delivery?.symbol,
      quality: delivery?.quality,
      supplier: delivery?.supplier,
    });
  });

  pw.mount(
    app,
    {
      method: "GET",
      path: "/v1/snapshot",
      resource: "GET /v1/snapshot",
      description: "Quartermaster market snapshot: normalised quote, FX view and signed timestamp",
      payTo: account.account,
      price: () => price,
      signedOrder: true,
    },
    async (req) => {
      const symbol = String(req.query.symbol ?? "EURUSD").toUpperCase();
      let bought: { supplier: string; name: string; tx: string; amount: string; data: Record<string, string> };
      try {
        // Well inside the buyer's payment window: past it, answer 503 so nothing is settled.
        bought = await requestJson(`${url("sourcing")}/buy`, { method: "POST", body: { symbol }, headers: internalHeaders(), timeoutMs: 180_000 });
      } catch (err) {
        const e = err as QmError;
        report("seller", "sale.not_charged", { symbol, reason: e.code, message: e.message });
        return { status: 503, body: { error: "upstream_unavailable", reason: e.code, message: "No charge was made. Try again shortly." } };
      }
      const q = bought.data;
      const servedAt = new Date();
      const ageMs = servedAt.getTime() - Date.parse(q.as_of!);
      const body = {
        symbol,
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        spread_bps: ((Number(q.ask) - Number(q.bid)) / Number(q.mid)) * 10_000,
        as_of: q.as_of,
        served_at: servedAt.toISOString(),
        upstream: bought.name,
      };
      const signature = createHmac("sha256", SIGNING_KEY).update(canonicalJson(body)).digest("hex");
      const delivery: Delivery = {
        id: newId("dlv"),
        symbol,
        supplier: bought.name,
        upstreamTx: bought.tx,
        upstreamCost: String(bought.amount),
        as_of: q.as_of!,
        served_at: body.served_at,
        age_ms: ageMs,
        quality: ageMs > STALE_MS ? "stale" : "ok",
        payloadHash: canonicalHash(body),
      };
      db.put("deliveries", delivery.id, delivery);
      return { status: 200, body: { ...body, signature, delivery_id: delivery.id }, deliveryId: delivery.id };
    },
  );
  log.info(`selling GET /v1/snapshot at ${usdz(price)}, paid to ${account.account}`);
}

function findSale(ref: string): SaleDoc | undefined {
  const byId = db.get<SaleDoc>("sales", ref);
  if (byId) return byId;
  const idx = db.get<{ settlementId: string }>("sales-by-tx", ref.toLowerCase());
  return idx ? db.get<SaleDoc>("sales", idx.settlementId) : undefined;
}

app.get("/info", route(() => ({ price: price.toString(), payTo: readAccount()?.account, resource: "GET /v1/snapshot" })));
app.get("/sales", route(() => db.list<SaleDoc>("sales")));
app.get("/sales/:ref", route((req) => {
  const s = findSale(String(req.params.ref));
  if (!s) throw new QmError("not_found", "no such sale", { status: 404 });
  return s;
}));
app.post("/sales/:ref/refund", requireInternal, route((req) => {
  const s = findSale(String(req.params.ref));
  if (!s) throw new QmError("not_found", "no such sale", { status: 404 });
  return db.put("sales", s.settlementId, { ...s, refundTx: String(req.body.tx) });
}));
app.post("/admin/price", requireInternal, route((req) => {
  const old = price;
  price = toCents(String(req.body.price));
  report("seller", "seller.price_changed", { from: old, to: price });
  return { price: price.toString() };
}));

serve(app, "seller", "seller");
void mountWhenReady();
