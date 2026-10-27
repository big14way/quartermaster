import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { getJson, postJson, sleep, waitForHealth, type QmEvent } from "@qm/core";
import { loadDotEnv } from "./dotenv";
import { narrate } from "./narrate";

// Starts every Quartermaster process with its own environment, waits for each to be
// healthy, and either runs the story headless (approving as the founder when asked) or
// leaves it to the dashboard.
//
//   pnpm demo                 offline, interactive: open the dashboard, approve on the keyring page
//   pnpm demo --headless      offline, runs the whole story and exits with the reconciliation result
//   pnpm demo --live          Metal testnet + Airwallex sandbox (needs .env)
//   pnpm demo --keep          keep var/ state from the last run

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const headless = args.has("--headless");
const root = resolve(import.meta.dirname, "..");
const tsx = join(createRequire(import.meta.url).resolve("tsx/package.json"), "..", "dist", "cli.mjs");

if (!headless && !existsSync(join(root, "apps", "dashboard", "dist", "index.html"))) {
  console.log("[demo] building the dashboard…");
  spawnSync("pnpm", ["--filter", "@qm/dashboard", "build"], { cwd: root, stdio: "inherit" });
}

// var/ holds keys, credentials and books for one mode. Never reuse simnet state on testnet
// or the other way round, even with --keep.
const modeFile = join(root, "var", ".mode");
const runMode = live ? "live" : "offline";
const keptMode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : undefined;
if (args.has("--keep") && keptMode && keptMode !== runMode) console.log(`[demo] var/ holds ${keptMode} state; starting fresh for ${runMode}`);
if (!args.has("--keep") || (keptMode && keptMode !== runMode)) rmSync(join(root, "var"), { recursive: true, force: true });
mkdirSync(join(root, "var"), { recursive: true });
writeFileSync(modeFile, runMode);

const dotenv = loadDotEnv(root);
// Live Metal can run before the Airwallex sandbox account is approved: without sandbox keys
// the Airwallex side stays on the simulator, and every surface says so.
const awxSim = !live || dotenv.QM_AIRWALLEX === "sim" || process.env.QM_AIRWALLEX === "sim" || !(dotenv.AIRWALLEX_API_KEY || process.env.AIRWALLEX_API_KEY);
const runId = `${live ? "live" : "offline"}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const pin = String(randomInt(100000, 999999));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...dotenv,
  QM_MODE: live ? "live" : "offline",
  QM_AIRWALLEX: awxSim ? "sim" : "live",
  QM_HOME: root,
  QM_RUN_ID: runId,
  QM_INTERNAL_TOKEN: randomBytes(16).toString("hex"),
  QM_APPROVAL_SECRET: randomBytes(32).toString("hex"),
  QM_FOUNDER_PIN: pin,
  QM_SELLER_SIGNING_KEY: randomBytes(32).toString("hex"),
  ...(awxSim ? { AIRWALLEX_WEBHOOK_SECRET: `whsec_${randomBytes(12).toString("hex")}` } : {}),
  FORCE_COLOR: "1",
};
// The founder PIN belongs to the keyring alone; every other process starts without it.
const withoutPin = { ...env, QM_FOUNDER_PIN: undefined };

const children: ChildProcess[] = [];
function start(name: string, file: string, argv: string[] = [], extraEnv: NodeJS.ProcessEnv = withoutPin) {
  const child = spawn(process.execPath, [tsx, file, ...argv], { cwd: root, env: extraEnv, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.trim() && !/DeprecationWarning|--trace-deprecation|ExperimentalWarning|SQLite is an experimental/.test(l))
      .forEach((l) => {
        if (!headless || /error|Error|✗|took [0-9]/.test(l)) console.log(l.includes(`[${name}]`) ? l : `[${name}] ${l}`);
      });
  child.stdout!.on("data", prefix);
  child.stderr!.on("data", prefix);
  child.on("exit", (code) => {
    if (!shuttingDown && code !== 0) console.error(`[demo] ${name} exited with ${code}`);
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(code: number) {
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(130));

const app = (name: string) => join(root, "apps", name, "src", "main.ts");
const health = (p: number) => waitForHealth(`http://127.0.0.1:${p}/health`, 40_000);

const label = !live ? "offline (simnet + Airwallex simulator, SIMULATED)" : awxSim ? "LIVE Metal testnet · Airwallex SIMULATED (no sandbox keys in .env)" : "LIVE (Metal testnet, Airwallex sandbox)";
console.log(`[demo] Quartermaster ${label} · run ${runId}`);
if (!live || awxSim) {
  start("sim", app("sim"));
  await Promise.all([...(live ? [] : [health(4700)]), health(4600)]);
}
start("feeds", app("feeds"));
start("keyring", app("keyring"), [], env);
for (const role of ["sourcing", "support", "treasury"]) start(role, app("agents"), [role]);
start("seller", app("seller"));
start("buyers", app("buyers"));
start("controller", app("controller"));
await Promise.all([4101, 4102, 4400, 4301, 4302, 4303, 4200, 4500, 4000].map(health));
console.log("[demo] all processes healthy");

const controller = "http://127.0.0.1:4000";

if (!headless) {
  console.log(`
  Dashboard:     ${controller}
  Founder PIN:   ${pin}   (approvals happen on the keyring's own page; nothing else holds this PIN)
  Ctrl+C to stop. The event log is written to runs/${runId}.jsonl
`);
} else {
  let since = 0;
  let approved = false;
  await postJson(`${controller}/api/story/all`, {});
  while (!shuttingDown) {
    const events = await getJson<QmEvent[]>(`${controller}/api/events?since=${since}`).catch(() => [] as QmEvent[]);
    for (const e of events) {
      since = e.seq;
      const line = narrate(e);
      if (line) console.log(line);
      const d = e.data as Record<string, any>;
      if (e.type === "plan.pending_approval" && !approved) {
        approved = true;
        // The supervisor plays the founder: open the link, enter the PIN.
        await sleep(1200);
        const u = new URL(String(d.approveUrl));
        await postJson(`${u.origin}${u.pathname}`, { t: u.searchParams.get("t"), pin, approver: "founder (headless demo)", decision: "approve" }).catch((err: Error) =>
          console.error(`[demo] approval failed: ${err.message}`),
        );
      }
      if (e.type === "story.step" && d.status === "failed") {
        console.error(`[demo] story failed at ${d.id}`);
        await sleep(1500);
        shutdown(1);
      }
      if (e.type === "recon.result") {
        console.log(`\n[demo] event log: runs/${runId}.jsonl  ·  replay with: pnpm replay runs/${runId}.jsonl`);
        await sleep(500);
        shutdown(d.ok ? 0 : 1);
      }
    }
    await sleep(250);
  }
}
