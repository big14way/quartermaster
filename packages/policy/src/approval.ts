import { createHmac, timingSafeEqual } from "node:crypto";
import { Decimal } from "decimal.js";
import { canonicalHash, canonicalJson, type Address, type Cents, type Role } from "@qm/core";
import type { MandateChange, OptionId, PlanOption, PlanState } from "./types";

/**
 * What a human approves. Canonical JSON with sorted keys, hashed with SHA-256; the
 * approval page shows exactly these fields, and the keyring rebuilds this record from live
 * state before it sends anything. Any drift (price moved, balance changed, mandate
 * replaced, expired) changes the hash and the keyring refuses.
 */
export interface ApprovalRecord {
  plan_id: string;
  option: OptionId;
  title: string;
  mandate_changes: {
    role: Role;
    mandate_id: string;
    old: { cap: Cents; budget: Cents; payees: Address[] | null };
    new: { cap: Cents; budget: Cents; payees: Address[] | null };
  }[];
  delta_usdz_cents: Cents;
  currency: "USDZ";
  counterparty: { address: Address | null; name: string };
  invoice_ref: string;
  evidence: {
    offer_header_sha256: string;
    offer_price_cents: Cents;
    refusal_code: string | null;
    refusal_tx: string | null;
    /** Only bound when the option touches the treasury budget. */
    fx_usd_per_eur: string | null;
    balance_cents: Cents;
    balances_snapshot_block: number;
    spent_cents: Record<Role, Cents>;
  };
  reason: string;
  expires_at: string;
}

export function approvalRecord(state: PlanState, opt: PlanOption, planId: string, reason: string, expiresAt: string): ApprovalRecord {
  const supplier = state.suppliers.find((s) => s.id === (opt.supplier ?? state.trigger?.supplier));
  const touchesTreasury = opt.changes.some((c) => c.role === "treasury");
  return {
    plan_id: planId,
    option: opt.id,
    title: opt.title,
    mandate_changes: opt.changes.map((c: MandateChange) => ({
      role: c.role,
      mandate_id: c.mandateId,
      old: { cap: c.old.cap, budget: c.old.budget, payees: c.old.payees },
      new: { cap: c.new.cap, budget: c.new.budget, payees: c.new.payees },
    })),
    delta_usdz_cents: opt.delta,
    currency: "USDZ",
    counterparty: { address: supplier?.address ?? null, name: supplier?.name ?? "none" },
    invoice_ref: state.invoice.id,
    evidence: {
      offer_header_sha256: state.trigger?.offerHeaderSha256 ?? "",
      offer_price_cents: state.trigger?.price ?? 0n,
      refusal_code: state.trigger?.refusal?.code ?? null,
      refusal_tx: state.trigger?.refusal?.tx ?? null,
      fx_usd_per_eur: touchesTreasury ? new Decimal(state.usdPerEur).toFixed(6) : null,
      balance_cents: state.balance,
      balances_snapshot_block: state.block,
      spent_cents: { sourcing: state.roles.sourcing.spent, support: state.roles.support.spent, treasury: state.roles.treasury.spent },
    },
    reason,
    expires_at: expiresAt,
  };
}

export const approvalHash = (r: ApprovalRecord) => canonicalHash(r);

export interface Approval {
  hash: string;
  approver: string;
  approvedAt: string;
  /** HMAC over hash, approver and time with the approval secret: a one-time signed link. */
  token: string;
}

export function signApproval(secret: string, hash: string, approver: string, approvedAt = new Date().toISOString()): Approval {
  const token = createHmac("sha256", secret).update(`${hash}|${approver}|${approvedAt}`).digest("hex");
  return { hash, approver, approvedAt, token };
}

export function verifyApproval(secret: string, a: Approval): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(`${a.hash}|${a.approver}|${a.approvedAt}`).digest("hex"), "hex");
  const given = Buffer.from(a.token, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A link token that lets one person open one plan's approval page. */
export function approvalLinkToken(secret: string, planId: string, hash: string): string {
  return createHmac("sha256", secret).update(`link|${planId}|${hash}`).digest("base64url");
}

export interface Recheck {
  ok: boolean;
  liveHash: string;
  drift: string[];
}

/**
 * Rebuild the record from live state and compare. Returns which fields drifted so the
 * refusal says why (price moved, balance changed, a mandate was replaced...).
 */
export function recheckApproval(approved: ApprovalRecord, live: ApprovalRecord, now = Date.now()): Recheck {
  const drift: string[] = [];
  if (Date.parse(approved.expires_at) < now) drift.push("approval expired");
  const a = JSON.parse(canonicalJson(approved)) as Record<string, unknown>;
  const b = JSON.parse(canonicalJson(live)) as Record<string, unknown>;
  diff(a, b, "", drift);
  const liveHash = approvalHash(live);
  return { ok: drift.length === 0 && liveHash === approvalHash(approved), liveHash, drift };
}

function diff(a: unknown, b: unknown, path: string, out: string[]) {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path || "record"} changed: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
}
