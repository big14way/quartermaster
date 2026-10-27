import type { QmEvent } from "./api";
import { LETTER, money, short } from "./format";

export type Tone = "info" | "good" | "bad" | "warn" | "plan" | "muted";

export interface Line {
  text: string;
  tone: Tone;
  tx?: string;
}

const letter = (r: string) => LETTER[r as keyof typeof LETTER] ?? r;

/** A short, readable line for the timeline; undefined for events that are only plumbing. */
export function describe(e: QmEvent): Line | undefined {
  const d = e.data;
  switch (e.type) {
    case "story.step":
      return d.status === "started" ? { text: `▶ ${d.title}`, tone: "plan" } : d.status === "failed" ? { text: `Step failed: ${d.error}`, tone: "bad" } : undefined;
    case "account.created":
      return { text: `Metal account ${short(d.account)} created`, tone: "info", tx: d.tx };
    case "account.funded":
      return { text: `Account funded with ${money(d.amount)}`, tone: "good", tx: d.tx };
    case "mandate.bound":
      return { text: `Mandate ${letter(d.role)} bound: cap ${money(d.cap)}, budget ${money(d.budget)}`, tone: "good", tx: d.tx };
    case "customer.ready":
      return { text: `Customer signed up: ${d.buyers.length} buyer agents, cap ${money(d.cap)}`, tone: "info" };
    case "invoice.booked":
      return { text: `Invoice ${d.id} booked: EUR ${money(d.amount, "")} due ${d.dueDate}`, tone: "info" };
    case "sale.settled":
      return { text: `Sale ${money(d.amount)} · ${d.symbol}${d.quality === "stale" ? " · stale quote" : ""}`, tone: d.quality === "stale" ? "warn" : "muted", tx: d.tx };
    case "sale.not_charged":
      return { text: `Buyer answered 503, not charged (${d.reason})`, tone: "warn" };
    case "sourcing.bought":
      return { text: `Sourcing bought from ${d.name} for ${money(d.amount)}`, tone: "muted", tx: d.tx };
    case "sourcing.refused":
      return d.stage === "account" ? { text: `Purchase refused on chain: ${d.code} (${d.name} ${money(d.price)} > cap ${money(d.cap)})`, tone: "bad", tx: d.tx } : undefined;
    case "feed.price_changed":
      return { text: `${d.name} price ${money(d.from)} → ${money(d.to)}`, tone: "warn" };
    case "feed.quality_changed":
      return { text: `${d.name} ${d.degraded ? "serving stale quotes" : "fresh again"}`, tone: "warn" };
    case "plan.opened":
      return { text: `Plan ${d.planId} opened`, tone: "plan" };
    case "plan.chosen":
      return { text: `Pick ${d.option}: ${d.title} (${d.source === "planner" ? d.planner.model : "rule-based"})`, tone: "plan" };
    case "plan.pending_approval":
      return { text: `Awaiting founder approval · sha256 ${short(d.hash, 8, 4)}`, tone: "plan" };
    case "plan.approved":
      return { text: `Approved by ${d.approver}`, tone: "good" };
    case "plan.refused":
      return { text: `Keyring refused: ${(d.drift ?? [d.error]).join("; ")}`, tone: "bad" };
    case "plan.rejected":
      return { text: `Plan rejected by ${d.approver}`, tone: "bad" };
    case "mandate.replaced":
      return { text: `Mandate ${letter(d.role)} replaced: cap ${money(d.cap.to)}, budget ${money(d.budget.from)} → ${money(d.budget.to)}`, tone: "good", tx: d.tx };
    case "plan.verified":
      return { text: `mandate verify passes for ${d.verifications.length} credentials; I1–I5 hold`, tone: "good" };
    case "agent.reloaded":
      return { text: `${d.role} agent reloaded its credential`, tone: "muted" };
    case "dispute.filed":
      return { text: `${d.buyer} disputes ${d.charges.length} charges`, tone: "warn" };
    case "refund.paid":
      return { text: `Refund ${money(d.amount)} to the buyer under R`, tone: "good", tx: d.tx };
    case "dispute.resolved":
      return { text: `Dispute resolved: ${d.refundedCount} refunded, ${d.decisions.length - d.refundedCount} not`, tone: "info" };
    case "sweep.pulled":
      return { text: `Swept ${money(d.amount)} to the ramp under T`, tone: "good", tx: d.tx };
    case "deposit.simulated":
      return { text: `Airwallex deposit simulated, reference = sweep tx`, tone: "info" };
    case "awx.deposit_settled":
      return { text: `USD ${money(d.amount, "")} deposit settled`, tone: "good" };
    case "fx.quoted":
      return { text: `MIN_1 quote: EUR ${money(d.buyEUR, "")} for USD ${money(d.sellUSD, "")}`, tone: "info" };
    case "fx.converted":
      return { text: `Converted (${d.requestId})`, tone: "good" };
    case "drill.crashed":
      return { text: `Executor killed after transfer create`, tone: "warn" };
    case "drill.recovered":
      return { text: `Retry found the same transfer via duplicate_request_id`, tone: "good" };
    case "awx.transfer_status":
      return d.ignored ? { text: `Late ${d.status} webhook ignored (kept ${d.kept})`, tone: "muted" } : { text: `Transfer → ${d.status}`, tone: d.status === "PAID" ? "good" : "info" };
    case "security.refused":
      return { text: `Compromised support agent refused on chain: ${d.reason}`, tone: "good", tx: d.tx };
    case "recon.result":
      return { text: d.ok ? "Books reconcile to the cent" : "Books do not reconcile", tone: d.ok ? "good" : "bad" };
    default:
      return undefined;
  }
}
