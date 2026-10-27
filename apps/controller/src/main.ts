import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { verifyWebhook, type WebhookEvent } from "@qm/airwallex";
import {
  EventLog,
  KIT,
  ROLES,
  airwallexMode,
  env,
  getJson,
  logger,
  mode,
  optionalEnv,
  readEvents,
  runsDir,
  sumCents,
  toJson,
  url,
  varDir,
  verifyChain,
} from "@qm/core";
import { checkInvariants } from "@qm/policy";
import { callInternal, credentialHistory, explorerTx, metalRail, readAccount, requireInternal, route, serve } from "@qm/runtime";
import { Books } from "./books";
import { PlanDesk } from "./planning";
import { reconcile } from "./reconcile";
import { Director, STEPS, type StepId } from "./story";

const log = logger("controller");
const replayFile = optionalEnv("QM_REPLAY_FILE");
const runId = env("QM_RUN_ID", new Date().toISOString().replace(/[:.]/g, "-"));
const bus = replayFile ? new EventLog() : new EventLog(join(runsDir(), `${runId}.jsonl`));
if (replayFile) for (const e of readEvents(replayFile)) bus.events.push(e);

const rail = metalRail({ home: varDir("controller") });
const books = replayFile ? undefined : new Books(bus);
const desk = new PlanDesk(bus, rail);
if (!replayFile) {
  bus.subscribe((e) => {
    try {
      books!.onEvent(e);
      desk.onEvent(e);
    } catch (err) {
      log.error(`while handling ${e.type}:`, err);
    }
  });
}

let liveCache: { at: number; value: unknown } | undefined;

/** What the dashboard's gauges show: read live from the chain, the agents and Airwallex. */
async function live() {
  if (replayFile) {
    const snap = [...bus.events].reverse().find((e) => e.type === "live.snapshot");
    return { ...((snap?.data as { live?: object })?.live ?? {}), replay: true };
  }
  if (liveCache && Date.now() - liveCache.at < 1000) return liveCache.value;
  const account = readAccount();
  const base = { mode: mode(), runId, account, totalAllocation: KIT.totalAllocation, keyring: url("keyring"), simnet: mode() === "offline" ? url("simnet") : undefined };
  if (!account) {
    liveCache = { at: Date.now(), value: { ...base, ready: false } };
    return liveCache.value;
  }
  try {
    const state = await desk.state();
    const awx = await getJson<{ balances: unknown[] }>(`${url("treasury")}/awx/snapshot`).catch(() => ({ balances: [] }));
    const sup = await getJson<{ supplier: string; paused: boolean }>(`${url("sourcing")}/supplier`).catch(() => undefined);
    const roles = Object.fromEntries(ROLES.map((r) => [r, { ...state.roles[r], versions: credentialHistory(r).length }]));
    const value = {
      ...base,
      ready: true,
      balance: state.balance,
      block: state.block,
      roles,
      sumBudgets: sumCents(ROLES.map((r) => state.roles[r].budget)),
      sumRemaining: sumCents(ROLES.map((r) => state.roles[r].budget - state.roles[r].spent)),
      invariants: checkInvariants(state),
      suppliers: state.suppliers,
      supplier: sup?.supplier,
      sourcingPaused: sup?.paused,
      usdPerEur: state.usdPerEur,
      invoice: state.invoice,
      awx: awx.balances,
      ledger: books?.ledger.trialBalance(),
      plan: desk.open,
      story: { running: director.running, done: director.done, error: director.error },
    };
    liveCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    return { ...base, ready: false, error: String((err as Error).message ?? err) };
  }
}

// Poll Airwallex for anything a webhook did not deliver (no public tunnel, lost, late).
if (!replayFile) {
  let polling = false;
  setInterval(async () => {
    if (polling || !readAccount()) return;
    polling = true;
    try {
      books!.foldSnapshot(await getJson(`${url("treasury")}/awx/snapshot`));
    } catch {
      /* treasury not ready yet */
    } finally {
      polling = false;
    }
  }, mode() === "live" ? 5000 : 4000);
}

const director = new Director(bus, desk, live, () => reconcile(bus, books!, desk, rail));

const app = express();

// Webhooks verify the raw bytes, so this route reads text before any JSON parsing.
app.post("/webhooks/airwallex", express.text({ type: "*/*", limit: "1mb" }), (req, res) => {
  const raw = typeof req.body === "string" ? req.body : "";
  const check = verifyWebhook(env("AIRWALLEX_WEBHOOK_SECRET", "whsec_offline"), { timestamp: req.header("x-timestamp"), signature: req.header("x-signature") }, raw);
  if (!check.ok) {
    bus.append({ type: "awx.webhook_rejected", actor: "controller", data: { reason: check.reason } });
    res.status(401).json({ error: check.reason });
    return;
  }
  // Acknowledge first, then process: Airwallex should never wait on our work.
  res.status(200).json({ received: true });
  setImmediate(() => {
    try {
      books?.onWebhook(JSON.parse(raw) as WebhookEvent);
    } catch (err) {
      log.error("webhook processing failed", err);
    }
  });
});

app.use(express.json({ limit: "2mb" }));

app.post("/events", requireInternal, route((req) => {
  const { type, actor, data } = req.body as { type: string; actor: string; data: Record<string, unknown> };
  const e = bus.append({ type, actor, data: data ?? {} });
  return { seq: e.seq, hash: e.hash };
}));

app.get("/api/meta", route(() => ({
  mode: mode(),
  airwallex: airwallexMode(),
  runId,
  replay: !!replayFile,
  steps: STEPS,
  keyring: url("keyring"),
  explorer: mode() === "offline" ? `${url("simnet")}/tx/` : explorerTx(""),
})));

app.get("/api/events", route((req) => {
  const since = Number(req.query.since ?? 0);
  return bus.events.filter((e) => e.seq > since);
}));

app.get("/api/stream", (req, res) => {
  res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.flushHeaders();
  const since = Number(req.query.since ?? 0);
  for (const e of bus.events) if (e.seq > since) res.write(`data: ${JSON.stringify(e)}\n\n`);
  const unsub = bus.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    unsub();
  });
});

app.get("/api/live", async (_req, res, next) => {
  try {
    res.type("application/json").send(toJson(await live()));
  } catch (err) {
    next(err);
  }
});

app.get("/api/chain", route(() => verifyChain(bus.events)));

app.post("/api/reconcile", route(() => {
  if (!books) throw new Error("replays do not reconcile; they re-render a recorded run");
  return reconcile(bus, books, desk, rail);
}));

app.post("/api/story/:step", route((req) => {
  if (replayFile) throw new Error("this is a replay");
  const step = String(req.params.step);
  const run = step === "all" ? director.runAll(req.query.from ? (String(req.query.from) as StepId) : undefined) : director.run(step as StepId);
  run.catch((err) => log.error(`story ${step} failed:`, err.message ?? err));
  return { accepted: step };
}));

app.get("/api/story", route(() => ({ steps: STEPS, running: director.running, done: director.done, error: director.error })));

app.post("/api/disputes", requireInternal, route((req) => callInternal("support", "/disputes", req.body)));

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard", "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|events|webhooks|health).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
} else {
  app.get("/", (_req, res) => {
    res.type("text").send("Dashboard not built. Run: pnpm dashboard:build");
  });
}

serve(app, "controller", "controller");
log.info(replayFile ? `replaying ${replayFile} (${bus.events.length} events)` : `run ${runId}, events → runs/${runId}.jsonl`);
