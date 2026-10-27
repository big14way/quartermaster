import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { AirwallexClient } from "@qm/airwallex";
import {
  QmError,
  env,
  logger,
  mode,
  optionalEnv,
  port,
  postJson,
  toJson,
  url,
  varDir,
  type Address,
  type Role,
  type Service,
} from "@qm/core";
import { LiveMetal, type AgentRail, type FacilitatorReader, type OwnerRail, type Paywall } from "@qm/metal";
import { SimMetal, SimPaywall } from "@qm/sim";

export type Rail = OwnerRail & AgentRail & FacilitatorReader;

export const LIVE_FACILITATOR = "https://x402-testnet.metalntwx.com/x402/facilitator";
export const LIVE_EXPLORER = "https://testnet.metalntwx.com";

/** The Metal rail for this mode: the simnet offline, metal-agent on testnet live. */
export function metalRail(opts: { ownerKeyFile?: string; home: string }): Rail {
  if (mode() === "offline") return new SimMetal({ simnetUrl: url("simnet"), ownerKeyFile: opts.ownerKeyFile });
  return new LiveMetal({
    rpcUrl: env("METAL_RPC_URL"),
    facilitatorUrl: env("METAL_FACILITATOR_URL", LIVE_FACILITATOR),
    faucetUrl: optionalEnv("METAL_FAUCET_URL"),
    ownerKeyFile: opts.ownerKeyFile,
    home: opts.home,
  });
}

export async function paywall(opts: { signedOrders: boolean }): Promise<Paywall> {
  if (mode() === "offline") return new SimPaywall({ simnetUrl: url("simnet") });
  const { LivePaywall } = await import("@qm/metal/live");
  return new LivePaywall({ facilitatorUrl: env("METAL_FACILITATOR_URL", LIVE_FACILITATOR), rpcUrl: env("METAL_RPC_URL"), signedOrders: opts.signedOrders });
}

export function airwallex(): AirwallexClient {
  if (mode() === "offline") return new AirwallexClient({ baseUrl: url("awxSim"), clientId: "sim-client", apiKey: "sim-key" });
  return new AirwallexClient({
    baseUrl: env("AIRWALLEX_BASE_URL", "https://api-demo.airwallex.com"),
    clientId: env("AIRWALLEX_CLIENT_ID"),
    apiKey: env("AIRWALLEX_API_KEY"),
  });
}

export function explorerTx(tx: string): string {
  return mode() === "offline" ? `${url("simnet")}/tx/${tx}` : `${LIVE_EXPLORER}/tx/${tx}`;
}

// ---- filesystem layout --------------------------------------------------------------

/** Each agent's private directory: only its own credential and mandate key live here. */
export const agentDir = (role: Role) => varDir("agents", role);
export const agentFiles = (role: Role) => ({
  dir: agentDir(role),
  credential: join(agentDir(role), "credential.json"),
  mandateKey: join(agentDir(role), "credential.key.json"),
  gasKey: join(agentDir(role), "gas-key.json"),
});

/** Public material anyone may read: the account address, credentials (no secrets), issuer public key. */
export const publicFiles = {
  dir: varDir("public"),
  account: varDir("public", "account.json"),
  issuer: varDir("public", "issuer.public.json"),
  credential: (role: Role) => varDir("public", `${role}.credential.json`),
  history: (role: Role) => varDir("public", `${role}.history.json`),
};

export interface AccountInfo {
  account: Address;
  owner: Address;
  ramp: Address;
  createdTx?: string;
}

export function readAccount(): AccountInfo | undefined {
  return existsSync(publicFiles.account) ? (JSON.parse(readFileSync(publicFiles.account, "utf8")) as AccountInfo) : undefined;
}

export function requireAccount(): AccountInfo {
  const a = readAccount();
  if (!a) throw new QmError("not_bootstrapped", "the Metal account is not created yet; run the setup step first");
  return a;
}

/** Credential files for a role, oldest first: every mandate the role has had, for verification. */
export function credentialHistory(role: Role): string[] {
  const f = publicFiles.history(role);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as string[]) : [];
}

// ---- HTTP -------------------------------------------------------------------------

export const INTERNAL_HEADER = "x-qm-token";
export const internalToken = () => env("QM_INTERNAL_TOKEN", "dev-internal-token");

export function jsonApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  return app;
}

/** Wrap an async handler: JSON out, QmError → 4xx with its code, anything else → 500. */
export const route =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.type("application/json").send(toJson(out ?? { ok: true }));
    } catch (err) {
      if (err instanceof QmError) {
        const status = typeof err.details.status === "number" && err.details.status >= 400 ? err.details.status : 409;
        res.status(status).type("application/json").send(toJson({ code: err.code, message: err.message, details: err.details }));
      } else next(err);
    }
  };

export function requireInternal(req: Request, _res: Response, next: NextFunction) {
  if (req.header(INTERNAL_HEADER) !== internalToken()) {
    next(new QmError("forbidden", "internal endpoint"));
    return;
  }
  next();
}

export function errorHandler(name: string) {
  const log = logger(name);
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof QmError) {
      res.status(403).json({ code: err.code, message: err.message });
      return;
    }
    log.error(err);
    res.status(500).json({ code: "internal_error", message: String((err as Error).message ?? err) });
  };
}

export function serve(app: express.Express, service: Service, name: string) {
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: name, mode: mode() });
  });
  app.use(errorHandler(name));
  const p = port(service);
  return app.listen(p, "127.0.0.1", () => logger(name).info(`listening on ${p} (${mode()})`));
}

export const internalHeaders = () => ({ [INTERNAL_HEADER]: internalToken() });

export function callInternal<T>(service: Service, path: string, body?: unknown): Promise<T> {
  return postJson<T>(`${url(service)}${path}`, body ?? {}, internalHeaders());
}

// ---- events -----------------------------------------------------------------------

const queue: { type: string; actor: string; data: Record<string, unknown> }[] = [];
let flushing = false;

/**
 * Report an event to the controller's hash-chained log. Delivery is ordered per process
 * and retried, so a slow controller never loses an event or blocks the caller.
 */
export function report(actor: string, type: string, data: Record<string, unknown> = {}) {
  queue.push({ type, actor, data: JSON.parse(toJson(data)) as Record<string, unknown> });
  void flush();
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      try {
        await postJson(`${url("controller")}/events`, queue[0], internalHeaders());
        queue.shift();
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } finally {
    flushing = false;
  }
}

export async function drainEvents(timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while ((queue.length || flushing) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}
