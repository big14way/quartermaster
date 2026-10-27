import { fromCents, type QmEvent } from "@qm/core";

// One line per event worth reading, for the terminal (headless demo and replay).

const c = (code: string, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const usd = (v: unknown) => `${fromCents(BigInt(String(v ?? 0)))} USDZ`;
const short = (h: unknown) => {
  const s = String(h ?? "");
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
};

export function narrate(e: QmEvent): string | undefined {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case "story.step":
      if (d.status === "started") return `\n${c("1;36", `▶ ${d.title}`)}\n  ${c("2", d.narration ?? "")}`;
      if (d.status === "failed") return c("31", `  ✗ step ${d.id} failed: ${d.error}`);
      return undefined;
    case "account.created":
      return `  Metal account ${short(d.account)} created; ramp address ${short(d.ramp)}`;
    case "account.funded":
      return `  Funded with ${usd(d.amount)}  ${c("2", short(d.tx))}`;
    case "plan.initial":
      return `  Opening split:\n${(d.explanation as string[]).map((x) => `    · ${x}`).join("\n")}`;
    case "mandate.bound":
      return `  Mandate ${d.role === "sourcing" ? "S" : d.role === "support" ? "R" : "T"} bound: cap ${usd(d.cap)}, budget ${usd(d.budget)}  ${c("2", short(d.tx))}`;
    case "customer.ready":
      return `  Customer account ${short(d.account)} with ${d.buyers.length} buyer agents (cap ${usd(d.cap)} each)`;
    case "invoice.booked":
      return `  Invoice ${d.id} from ${d.vendor}: EUR ${fromCents(BigInt(d.amount))}, due ${d.dueDate} (read by ${d.source === "claude" ? d.model : "rules"})`;
    case "awx.accounts_ready":
      return `  Airwallex USD and EUR Global Accounts ready`;
    case "feed.price_changed":
      return c("33", `  ${d.name} price ${usd(d.from)} → ${usd(d.to)}`);
    case "feed.quality_changed":
      return c("33", `  ${d.name} ${d.degraded ? "starts serving stale quotes" : "is fresh again"}`);
    case "sourcing.refused":
      return d.stage === "account"
        ? c("31", `  ✗ Purchase refused on chain: ${d.code} (${d.name} asks ${usd(d.price)}, cap S ${usd(d.cap)})  ${c("2", short(d.tx))}`)
        : undefined;
    case "sourcing.in_doubt":
      return c("33", `  ⚡ Upstream settlement timed out (settlement_in_doubt): ${d.resolution}  ${c("2", short(d.tx))}`);
    case "plan.options":
      return `  Options:\n${(d.options as any[]).map((o) => `    ${o.feasible ? c("32", "✓") : c("31", "✗")} ${o.id}. ${o.title}${o.feasible ? "" : c("2", ` (${o.reasons[0]})`)}`).join("\n")}`;
    case "plan.chosen":
      return `  Pick: ${c("1", `${d.option}. ${d.title}`)}  ${c("2", `[${d.source === "planner" ? d.planner.model : "rule-based fallback"}]`)}\n    ${d.explanation}${d.needsApproval ? `\n    Needs approval: ${(d.approvalReasons as string[]).join("; ")}` : ""}`;
    case "plan.pending_approval":
      return c("35", `  Awaiting founder approval, record sha256 ${short(d.hash)}`);
    case "plan.approved":
      return c("35", `  Approved by ${d.approver}`);
    case "plan.refused":
      return c("31", `  Keyring refused: ${(d.drift ?? [d.error]).join("; ")}`);
    case "mandate.replaced":
      return `  Mandate ${d.role === "sourcing" ? "S" : d.role === "support" ? "R" : "T"} replaced: cap ${usd(d.cap.from)} → ${usd(d.cap.to)}, budget ${usd(d.budget.from)} → ${usd(d.budget.to)}, spend carried ${usd(d.spentCarried)}  ${c("2", short(d.tx))}`;
    case "plan.verified":
      return c("32", `  ✓ mandate verify passes for ${(d.verifications as any[]).length} credentials; I1–I5 hold`);
    case "agent.reloaded":
      return `  ${d.role} agent reloaded its new credential`;
    case "dispute.read":
      return `  Dispute from ${d.buyer}: ${d.charges.length} charges, issue "${d.issue}"`;
    case "dispute.resolved":
      return `  Resolved: ${(d.decisions as any[]).map((x) => `${x.decision}`).join(", ")} → refunded ${d.refundedCount} (${d.refundedTotal} USDZ)\n${(d.decisions as any[]).map((x) => `    · ${x.decision}: ${x.why}`).join("\n")}`;
    case "sweep.pulled":
      return `  Swept ${usd(d.amount)} to the ramp under T  ${c("2", short(d.tx))}`;
    case "deposit.simulated":
      return `  Airwallex deposit ${short(d.depositId)} simulated, reference = sweep tx`;
    case "awx.deposit_settled":
      return `  Deposit settled: USD ${fromCents(BigInt(d.amount))}`;
    case "fx.quoted":
      return `  MIN_1 quote: buy EUR ${fromCents(BigInt(d.buyEUR))} for USD ${fromCents(BigInt(d.sellUSD))} (${d.usdPerEur} USD/EUR)`;
    case "fx.converted":
      return `  Converted, request_id ${d.requestId}`;
    case "drill.crashed":
      return c("33", `  ⚡ Executor killed after transfer create (${d.requestId})`);
    case "drill.recovered":
      return c("32", `  ✓ Retry with the same request_id → ${d.reused ? "duplicate_request_id, loaded" : "created"} transfer ${short(d.transferId)} (same: ${d.sameTransfer})`);
    case "awx.transfer_status":
      return d.ignored ? c("2", `  webhook ${d.status} arrived late; kept ${d.kept}`) : `  Transfer ${short(d.transferId)} → ${d.status}`;
    case "security.refused":
      return c("32", `  ✓ ${d.attempt}: refused on chain, ${d.reason}  ${c("2", short(d.tx))}`);
    case "recon.result":
      return `\n${(d.checks as any[]).map((x) => `  ${x.ok ? c("32", "✓") : c("31", "✗")} ${x.id}. ${x.title}: ${x.left} | ${x.right}`).join("\n")}\n  ${d.chain.ok ? c("32", "✓") : c("31", "✗")} Event log hash chain: ${d.chain.count} events, head ${short(d.chain.head)}\n  ${d.ok ? c("1;32", "Books reconcile to the cent.") : c("1;31", "Books do not reconcile.")}`;
    default:
      return undefined;
  }
}
