import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_WINDOW_MS = 5 * 60 * 1000;

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${rawBody}`).digest("hex");
}

export type WebhookCheck = { ok: true } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

/**
 * Verify an Airwallex webhook: HMAC-SHA256 over `x-timestamp + rawBody`, compared in
 * constant time, inside a 5-minute window. Verify the raw bytes, never re-serialised JSON.
 */
export function verifyWebhook(
  secret: string,
  headers: { timestamp?: string; signature?: string },
  rawBody: string,
  now = Date.now(),
): WebhookCheck {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WEBHOOK_WINDOW_MS) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
