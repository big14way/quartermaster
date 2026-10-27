import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Read KEY=value lines from the repo's .env (gitignored). Values already set in the environment win. */
export function loadDotEnv(root: string): Record<string, string> {
  const f = join(root, ".env");
  if (!existsSync(f)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[2] !== "") out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}
