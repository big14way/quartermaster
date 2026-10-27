import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { canonicalHash, fromCents, optionalEnv, toJson, usdz } from "@qm/core";
import type { PlanOption, PlanState, PlannerChoice } from "@qm/policy";
import { invoiceRequiredUsd, refundFloor, remaining } from "@qm/policy";

const OPTION_IDS = ["A", "B", "C", "D", "E"] as const;

const PlannerSchema = z.object({
  option: z.enum(OPTION_IDS),
  delta_usdz_cents: z.string(),
  new_sourcing_cap_cents: z.string(),
  ranking: z.array(z.enum(OPTION_IDS)),
  explanation: z.string(),
  rejected: z.array(z.object({ option: z.enum(OPTION_IDS), why: z.string() })),
});

/** Every LLM call is recorded with a hash of its input, so a replay returns the same output. */
export interface LlmRecorder {
  lookup(kind: string, inputHash: string): unknown | undefined;
  record(entry: { kind: string; model: string; inputHash: string; input: unknown; output: unknown; ms: number; error?: string }): void;
}

export interface PlannerResult {
  choice?: PlannerChoice;
  model: string;
  source: "claude" | "replay" | "unavailable";
  error?: string;
}

const SYSTEM = `You are the planning step of Quartermaster's treasury agent. Three AI agents run a pay-per-call data API from one Metal account: sourcing buys upstream data (mandate S), support refunds buyers (mandate R), treasury moves earnings to Airwallex and pays a EUR licence fee (mandate T). Each mandate is an on-chain spending limit: a per-payment cap and a total budget.

A supplier's price just rose past the sourcing cap and the account refused the purchase. Code has already enumerated every option and computed every number, and has marked each option feasible or not with reasons.

Your job:
1. Pick exactly one option that code marked feasible. Prefer the option that keeps sourcing running at the best margin without putting the licence fee or the refund reserve at risk.
2. Copy its delta_usdz_cents and its new sourcing cap (new_sourcing_cap_cents) exactly as given. If the option leaves mandate S unchanged, copy the current cap. Never compute or adjust a number.
3. Rank all five options from best to worst.
4. Write the explanation for the founder who must approve the change: two or three plain sentences, no jargon, naming the amounts in USDZ and why the runner-up was not chosen.
5. For each option you did not pick, give one short reason.

The numbers and feasibility are final. You explain and rank; code and the chain decide.`;

/** The option table as the planner sees it: every figure pre-computed, in cents and in USDZ. */
export function plannerInput(state: PlanState, options: PlanOption[]) {
  return {
    trigger: {
      supplier: state.trigger?.supplier,
      new_price: usdz(state.trigger?.price ?? 0n),
      refusal: state.trigger?.refusal?.code ?? null,
      current_sourcing_cap: usdz(state.roles.sourcing.cap),
    },
    business: {
      sell_price: usdz(state.limits.sellPrice),
      min_margin: usdz(state.limits.minMargin),
      total_allocation: usdz(state.limits.totalAllocation),
      account_balance: usdz(state.balance),
      forecast: `${state.forecast.callsPerHour} calls/hour, keep ${state.forecast.runwayHours} hours of runway`,
    },
    mandates: Object.fromEntries(
      Object.values(state.roles).map((r) => [r.role, { cap: usdz(r.cap), budget: usdz(r.budget), spent: usdz(r.spent), remaining: usdz(remaining(r)) }]),
    ),
    licence_fee: {
      invoice: state.invoice.id,
      vendor: state.invoice.vendor,
      amount: `EUR ${fromCents(state.invoice.amount)}`,
      due: state.invoice.dueAt.slice(0, 10),
      usd_per_eur: state.usdPerEur,
      treasury_needs: usdz(invoiceRequiredUsd(state)),
      paid: state.invoice.paid,
    },
    refund_floor: usdz(refundFloor(state)),
    options: options.map((o) => ({
      option: o.id,
      title: o.title,
      feasible: o.feasible,
      reasons: o.reasons,
      delta_usdz_cents: o.delta.toString(),
      new_sourcing_cap_cents: (o.changes.find((c) => c.role === "sourcing")?.new.cap ?? state.roles.sourcing.cap).toString(),
      margin_per_call: usdz(o.marginPerCall),
      needs_approval: o.needsApproval,
      approval_reasons: o.approvalReasons,
      changes: o.changes.map((c) => ({
        mandate: c.role,
        cap: `${usdz(c.old.cap)} → ${usdz(c.new.cap)}`,
        budget: `${usdz(c.old.budget)} → ${usdz(c.new.budget)}`,
      })),
    })),
  };
}

/**
 * Ask Claude to rank the enumerated options and explain the pick. Returns no choice when
 * there is no API key, the call fails, or the model declines; the policy engine then uses
 * its deterministic rule. A recorded output is returned instead of calling the API when
 * the recorder has one for the same input (replays).
 */
export async function planWithClaude(state: PlanState, options: PlanOption[], recorder?: LlmRecorder): Promise<PlannerResult> {
  const model = optionalEnv("QM_PLANNER_MODEL") ?? "claude-opus-5-5";
  const input = plannerInput(state, options);
  const inputHash = canonicalHash({ model, system: SYSTEM, input });

  const recorded = recorder?.lookup("planner", inputHash) as PlannerChoice | undefined;
  if (recorded) return { choice: recorded, model, source: "replay" };

  if (!optionalEnv("ANTHROPIC_API_KEY") && !optionalEnv("ANTHROPIC_AUTH_TOKEN")) {
    recorder?.record({ kind: "planner", model, inputHash, input, output: null, ms: 0, error: "no API key; deterministic rule used" });
    return { model, source: "unavailable", error: "no API key" };
  }

  const started = Date.now();
  try {
    const client = new Anthropic();
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: betaZodOutputFormat(PlannerSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: `Live state and the option table, as JSON:\n\n${toJson(input, 2)}` }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      const error = response.stop_reason === "refusal" ? `declined (${response.stop_details?.category ?? "no category"})` : "no parsed output";
      recorder?.record({ kind: "planner", model, inputHash, input, output: null, ms: Date.now() - started, error });
      return { model, source: "unavailable", error };
    }
    const choice: PlannerChoice = response.parsed_output;
    recorder?.record({ kind: "planner", model: response.model, inputHash, input, output: choice, ms: Date.now() - started });
    return { choice, model: response.model, source: "claude" };
  } catch (err) {
    const error = err instanceof Anthropic.APIError ? `API ${err.status}: ${err.message}` : String(err);
    recorder?.record({ kind: "planner", model, inputHash, input, output: null, ms: Date.now() - started, error });
    return { model, source: "unavailable", error };
  }
}
