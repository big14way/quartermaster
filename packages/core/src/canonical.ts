import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, no whitespace, bigint written as a decimal string,
 * undefined members dropped. Two structurally equal values always produce the same text,
 * which is what approval hashes and the event chain rely on.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = normalize(v);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** JSON.stringify replacer that writes bigint as a string, for logs and HTTP bodies. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, bigintReplacer, space);
}
