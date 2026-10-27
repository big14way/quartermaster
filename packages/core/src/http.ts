import { toJson } from "./canonical";
import { QmError } from "./types";

export interface JsonRequest {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Small JSON-over-HTTP helper for calls between Quartermaster processes. */
export async function requestJson<T = unknown>(url: string, req: JsonRequest = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      method: req.method ?? (req.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...req.headers },
      body: req.body === undefined ? undefined : toJson(req.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const parsed = text ? safeParse(text) : undefined;
    if (!res.ok) {
      const p = (parsed ?? {}) as { code?: string; error?: string; message?: string };
      throw new QmError(p.code ?? `http_${res.status}`, p.message ?? p.error ?? text.slice(0, 300), {
        status: res.status,
        url,
        body: parsed,
      });
    }
    return parsed as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new QmError("timeout", `request to ${url} timed out`, { url });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const getJson = <T = unknown>(url: string, headers?: Record<string, string>) =>
  requestJson<T>(url, { method: "GET", headers });

export const postJson = <T = unknown>(url: string, body: unknown, headers?: Record<string, string>) =>
  requestJson<T>(url, { method: "POST", body, headers });

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`service at ${url} not healthy after ${timeoutMs}ms: ${String(lastErr)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COLORS = ["36", "33", "35", "32", "34", "31", "96", "93", "95", "92"];
let colorIdx = 0;

export function logger(name: string) {
  const color = COLORS[colorIdx++ % COLORS.length];
  const tag = process.stdout.isTTY ? `\x1b[${color}m[${name}]\x1b[0m` : `[${name}]`;
  return {
    info: (...args: unknown[]) => console.log(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}
