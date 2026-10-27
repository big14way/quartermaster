import { join, resolve } from "node:path";
import type { Cents } from "./money";
import type { Mode, Role } from "./types";

export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing environment variable ${name}`);
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function mode(): Mode {
  const m = env("QM_MODE", "offline");
  if (m !== "offline" && m !== "live") throw new Error(`QM_MODE must be offline or live, got ${m}`);
  return m;
}

/**
 * Airwallex can run on the simulator while Metal is live (no sandbox keys yet). Defaults to
 * following QM_MODE.
 */
export function airwallexMode(): "sim" | "live" {
  const v = optionalEnv("QM_AIRWALLEX");
  if (v === "sim" || v === "live") return v;
  return mode() === "offline" ? "sim" : "live";
}

export const DEFAULT_PORTS = {
  controller: 4000,
  feedA: 4101,
  feedB: 4102,
  seller: 4200,
  sourcing: 4301,
  support: 4302,
  treasury: 4303,
  keyring: 4400,
  buyers: 4500,
  awxSim: 4600,
  simnet: 4700,
} as const;
export type Service = keyof typeof DEFAULT_PORTS;

export function port(service: Service): number {
  return Number(env(`QM_PORT_${service.toUpperCase()}`, String(DEFAULT_PORTS[service])));
}

export function url(service: Service): string {
  return env(`QM_URL_${service.toUpperCase()}`, `http://127.0.0.1:${port(service)}`);
}

export const AGENT_SERVICE: Record<Role, Service> = { sourcing: "sourcing", support: "support", treasury: "treasury" };

/** Root for runtime state: keys, credentials, sqlite, run logs. Gitignored. */
export function homeDir(): string {
  return resolve(env("QM_HOME", process.cwd()));
}

export function varDir(...parts: string[]): string {
  return join(homeDir(), "var", ...parts);
}

export function runsDir(): string {
  return join(homeDir(), "runs");
}

/**
 * The scenario from the kit: a data business whose three agents share 20 USDZ. A query
 * sells for 5 cents and its upstream data costs 2 cents. The upstream price later rises
 * to 4 cents, past the sourcing cap of 3 cents.
 */
export const KIT = {
  /** Total the three budgets may add up to, held in code (the account caps each budget, not the sum). */
  totalAllocation: 2000n as Cents,
  /** Gas held back for owner-key transactions when they are paid from the account. */
  gasReserve: 0n as Cents,
  sellPrice: 5n as Cents,
  minMargin: 1n as Cents,
  initialPlan: {
    sourcing: { cap: 3n as Cents, budget: 1000n as Cents },
    support: { cap: 10n as Cents, budget: 400n as Cents },
    treasury: { cap: 600n as Cents, budget: 600n as Cents },
  },
  feeds: {
    A: { name: "Feed A", initialPrice: 2n as Cents, spikePrice: 4n as Cents },
    B: { name: "Feed B", initialPrice: 3n as Cents, spikePrice: 5n as Cents },
  },
  licence: {
    invoiceId: "LIC-2026-11",
    vendor: "Nordlicht Data GmbH",
    description: "Market data redistribution licence, November 2026",
    currency: "EUR",
    amount: 500n as Cents,
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    country: "DE",
    city: "Berlin",
    street: "Torstrasse 140",
    postcode: "10119",
    dueInDays: 4,
  },
  fx: {
    /** Buffer on the live rate when sizing the treasury budget, in basis points. */
    bufferBps: 200n,
    /** Transfer fee estimate in the payout currency's cents. */
    feeEstimate: 15n as Cents,
  },
  forecast: {
    callsPerHour: 120n,
    runwayHours: 2n,
    headroomCalls: 10n,
    refundsP95PerHour: 6n,
    /** Price pass-through guard for option D: our sell price may rise at most this much. */
    maxPassThroughBps: 2000n,
  },
  approval: {
    /** Any cap rising by more than this needs a human. */
    capRiseBps: 2500n,
    /** Any budget moving by more than this needs a human. */
    deltaThreshold: 100n as Cents,
    ttlSeconds: 900,
  },
  customer: {
    funding: 1000n as Cents,
    mandate: { cap: 10n as Cents, budget: 500n as Cents },
    buyers: ["atlas-research", "brightline-quant", "corvid-analytics"],
  },
  symbols: ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"],
} as const;

export type Kit = typeof KIT;
