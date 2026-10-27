import { randomBytes } from "node:crypto";

/** The Airwallex sandbox accepted request_ids up to 47 characters and rejected 54+. */
export const MAX_REQUEST_ID = 47;

export function assertRequestId(id: string): string {
  if (id.length > MAX_REQUEST_ID) {
    throw new Error(`request_id "${id}" is ${id.length} chars; the limit is ${MAX_REQUEST_ID}`);
  }
  if (!/^[A-Za-z0-9:_\-.]+$/.test(id)) throw new Error(`request_id "${id}" has unsupported characters`);
  return id;
}

/**
 * Airwallex request_ids. `attempt` increments only after a terminal failure, never on a
 * network retry, so a retried call always reuses the id of the call it repeats.
 */
export const requestIds = {
  conversion: (invoiceId: string, attempt: number) => assertRequestId(`qm:cv:${invoiceId}:${attempt}`),
  transfer: (invoiceId: string, attempt: number) => assertRequestId(`qm:tr:${invoiceId}:${attempt}`),
  globalAccount: (ccy: string, env: string) => assertRequestId(`qm:ga:${ccy}:${env}`),
};

export function newId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

/** Metal pull --payment-id values. One id per payout that could otherwise repeat. */
export const paymentIds = {
  refund: (settlementId: string) => `refund:${settlementId}`,
  sweep: (sweepId: string) => `sweep:${sweepId}`,
};
