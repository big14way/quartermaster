import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readEvents, verifyChain } from "@qm/core";
import { narrate } from "./narrate";

// Re-render a recorded run. Verifies the event log's hash chain, prints the story, and
// with --serve opens the dashboard on the recording: no keys, no chain, no Airwallex.
//
//   pnpm replay runs/sample-offline.jsonl
//   pnpm replay runs/sample-offline.jsonl --serve

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file || !existsSync(file)) {
  console.error("usage: pnpm replay runs/<id>.jsonl [--serve]");
  process.exit(2);
}

const events = readEvents(file);
const chain = verifyChain(events);
console.log(`${file}: ${events.length} events, hash chain ${chain.ok ? "intact" : `BROKEN at #${chain.brokenAt} (${chain.reason})`}, head ${chain.head.slice(0, 16)}…`);
const llm = events.filter((e) => e.type === "llm.call");
if (llm.length) console.log(`${llm.length} recorded model calls (inputs hashed, outputs kept): replays never call the API`);

for (const e of events) {
  const line = narrate(e);
  if (line) console.log(line);
}

if (!chain.ok) process.exit(1);

if (args.includes("--serve")) {
  const root = resolve(import.meta.dirname, "..");
  const tsx = join(createRequire(import.meta.url).resolve("tsx/package.json"), "..", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, join(root, "apps", "controller", "src", "main.ts")], {
    cwd: root,
    env: { ...process.env, QM_REPLAY_FILE: resolve(file), QM_HOME: join(root, "var", "replay") },
    stdio: "inherit",
  });
  console.log("\nDashboard (replay): http://127.0.0.1:4000   Ctrl+C to stop");
  process.on("SIGINT", () => child.kill("SIGTERM"));
}
