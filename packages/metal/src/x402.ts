import { baseUnitsToCents, toCents, type Address, type Cents } from "@qm/core";
import { METAL_NETWORK } from "./rail";

// x402 v2 over HTTP: a 402 carries a base64 JSON `PAYMENT-REQUIRED` header, the retry
// carries `PAYMENT-SIGNATURE`, and the paid response carries `PAYMENT-RESPONSE`.
export const HEADER_REQUIRED = "payment-required";
export const HEADER_SIGNATURE = "payment-signature";
export const HEADER_RESPONSE = "payment-response";

export interface Requirement {
  scheme: string;
  network: string;
  /** Base units (18 decimals for USDZ). */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: Requirement[];
}

export interface PaymentResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export interface Offer {
  price: Cents;
  payTo: Address;
  network: string;
  asset: string;
  signedOrderRequired: boolean;
  resource?: string;
  requirement: Requirement;
}

/**
 * The `exact` USDZ offer on Metal from a 402, priced in cents. Read on every request and
 * never cached: the price is the supplier's to change at any time.
 */
export function exactOffer(required: PaymentRequired | undefined): Offer | undefined {
  const req = required?.accepts.find((a) => a.scheme === "exact" && a.network === METAL_NETWORK);
  if (!req) return undefined;
  return {
    price: baseUnitsToCents(req.amount, "up"),
    payTo: req.payTo as Address,
    network: req.network,
    asset: req.asset,
    signedOrderRequired: req.extra?.["signedOffer"] === "required",
    resource: typeof req.extra?.["resource"] === "string" ? (req.extra["resource"] as string) : undefined,
    requirement: req,
  };
}

/** GET the URL without paying and read its offer. */
export async function probeOffer(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{
  status: number;
  offer?: Offer;
  required?: PaymentRequired;
  body?: unknown;
}> {
  const res = await fetch(url, { method: init.method ?? "GET", headers: init.headers });
  const required = decodeHeader<PaymentRequired>(res.headers.get(HEADER_REQUIRED));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, offer: exactOffer(required), required, body };
}

/** Parse a refusal reason ("mandate_cap_exceeded") out of a CLI or facilitator message. */
export function refusalCode(message: string): string {
  const m = /\b(mandate_[a-z_]+|transfer_would_fail|settlement_in_doubt|payment_in_flight|already_settled|nonce_already_used|recipient_refuses|payment_quarantined|signed_offer_[a-z_]+|rate_limited|daily_limit_reached)\b/.exec(
    message,
  );
  return m?.[1] ?? "payment_refused";
}

export function usdzToCents(text: string): Cents {
  return toCents(text.replace(/\*?USDZ/i, "").trim());
}
