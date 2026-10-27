import { existsSync, readFileSync, watchFile } from "node:fs";
import type { Express } from "express";
import { logger, type MandateStatus, type Role } from "@qm/core";
import type { LlmRecorder } from "@qm/planner";
import { agentFiles, metalRail, report, route, type Rail } from "@qm/runtime";

export interface AgentContext {
  role: Role;
  rail: Rail;
  files: ReturnType<typeof agentFiles>;
  log: ReturnType<typeof logger>;
  /** Mandate status, cached briefly and dropped whenever the credential file changes. */
  status(fresh?: boolean): Promise<MandateStatus>;
  recorder: LlmRecorder;
}

function mandateIdOnDisk(path: string): string | undefined {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as { mandateId?: string; mandate?: string };
    return c.mandateId ?? c.mandate;
  } catch {
    return undefined;
  }
}

/**
 * Shared agent plumbing. The process can read only its own directory: its credential and
 * its mandate key. After the keyring replaces the mandate it writes a new credential here;
 * the agent reloads it on the next payment, and the old one is refused as mandate_revoked.
 */
export function agentContext(role: Role): AgentContext {
  const files = agentFiles(role);
  const rail = metalRail({ home: files.dir });
  const log = logger(role);
  let cached: { at: number; status: MandateStatus } | undefined;
  let lastId = existsSync(files.credential) ? mandateIdOnDisk(files.credential) : undefined;

  watchFile(files.credential, { interval: 250 }, () => {
    const id = mandateIdOnDisk(files.credential);
    cached = undefined;
    if (id && id !== lastId) {
      // The first credential is a load, not a reload; only replacements are worth an event.
      if (lastId) {
        log.info(`reloaded credential ${id.slice(0, 12)}…`);
        report(role, "agent.reloaded", { role, from: lastId, to: id });
      }
      lastId = id;
    }
  });

  return {
    role,
    rail,
    files,
    log,
    recorder: { lookup: () => undefined, record: (e) => report(role, "llm.call", e as unknown as Record<string, unknown>) },
    async status(fresh = false) {
      if (!fresh && cached && Date.now() - cached.at < 3000) return cached.status;
      const status = await rail.status(files.credential);
      cached = { at: Date.now(), status };
      return status;
    },
  };
}

export function mountCommon(app: Express, ctx: AgentContext) {
  app.get("/status", route(() => ctx.status(true)));
}
