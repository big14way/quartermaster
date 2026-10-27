import type { TransferStatus } from "./types";

const RANK: Partial<Record<TransferStatus, number>> = {
  SCHEDULED: 0,
  OVERDUE: 0,
  SUSPENDED: 0,
  PROCESSING: 1,
  SENT: 2,
  PAID: 3,
};

export interface StatusUpdate {
  status: TransferStatus;
  updated_at: string;
}

/**
 * Monotonic guard for transfer status. Webhooks and polls arrive in any order, so a
 * transfer only moves forward in rank. FAILED overrides anything, even a PAID (a bank
 * can bounce a payment after it was marked paid). A CANCELLED arriving after FAILED is
 * ignored, and within the same rank the later `updated_at` wins.
 */
export function nextTransferStatus(current: StatusUpdate | undefined, incoming: StatusUpdate): StatusUpdate {
  if (!current) return incoming;
  if (current.status === "FAILED") return current;
  if (incoming.status === "FAILED") return incoming;
  if (incoming.status === "CANCELLED") return current.status === "PAID" ? current : incoming;
  if (current.status === "CANCELLED") return current;
  const a = RANK[current.status] ?? 0;
  const b = RANK[incoming.status] ?? 0;
  if (b > a) return incoming;
  if (b < a) return current;
  return incoming.updated_at > current.updated_at ? incoming : current;
}

export function isTerminal(status: TransferStatus): boolean {
  return status === "PAID" || status === "FAILED" || status === "CANCELLED";
}
