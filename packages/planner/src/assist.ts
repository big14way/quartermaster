import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { canonicalHash, optionalEnv } from "@qm/core";
import type { LlmRecorder } from "./planner";

const InvoiceSchema = z.object({
  invoice_id: z.string(),
  vendor: z.string(),
  currency: z.string(),
  amount: z.string(),
  iban: z.string(),
  bic: z.string(),
  due_date: z.string(),
  payment_reference: z.string(),
});
export type InvoiceFields = z.infer<typeof InvoiceSchema>;

const ClaimSchema = z.object({
  /** Transaction hashes (0x…) or settlement ids (stl_…) of the disputed charges. */
  charges: z.array(z.string()),
  claimed_issue: z.enum(["stale_data", "wrong_data", "not_delivered", "duplicate_charge", "other"]),
  summary: z.string(),
});
export type ClaimFields = z.infer<typeof ClaimSchema>;

async function extract<T>(
  kind: string,
  system: string,
  text: string,
  schema: z.ZodType<T>,
  fallback: (text: string) => T,
  recorder?: LlmRecorder,
): Promise<{ fields: T; source: "claude" | "replay" | "rules"; model: string; error?: string }> {
  const model = optionalEnv("QM_ASSIST_MODEL") ?? "claude-sonnet-5-5";
  const inputHash = canonicalHash({ kind, model, system, text });
  const recorded = recorder?.lookup(kind, inputHash) as T | undefined;
  if (recorded) return { fields: recorded, source: "replay", model };
  if (!optionalEnv("ANTHROPIC_API_KEY") && !optionalEnv("ANTHROPIC_AUTH_TOKEN")) {
    const fields = fallback(text);
    recorder?.record({ kind, model: "rules", inputHash, input: { text }, output: fields, ms: 0, error: "no API key; rule-based extraction" });
    return { fields, source: "rules", model: "rules" };
  }
  const started = Date.now();
  try {
    const client = new Anthropic();
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: text }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(response.stop_reason === "refusal" ? "declined" : "no parsed output");
    const fields = response.parsed_output as T;
    recorder?.record({ kind, model: response.model, inputHash, input: { text }, output: fields, ms: Date.now() - started });
    return { fields, source: "claude", model: response.model };
  } catch (err) {
    const fields = fallback(text);
    const error = err instanceof Anthropic.APIError ? `API ${err.status}: ${err.message}` : String(err);
    recorder?.record({ kind, model, inputHash, input: { text }, output: fields, ms: Date.now() - started, error });
    return { fields, source: "rules", model: "rules", error };
  }
}

const INVOICE_SYSTEM = `Extract the payment fields from this supplier invoice exactly as printed. amount is the total due as a plain decimal with no currency symbol or thousands separator. due_date is ISO yyyy-mm-dd. iban has no spaces. payment_reference is the reference the vendor asks to quote. If a field is missing, return an empty string for it. Do not infer or correct anything.`;

const CLAIM_SYSTEM = `A customer's agent is disputing charges for a paid data API. List every charge it disputes, as written: transaction hashes (0x followed by 64 hex characters) or settlement ids (beginning with "stl_"). Classify the issue it claims and summarise the claim in one sentence. Only list references that appear in the text. You do not decide refunds.`;

export function extractInvoice(text: string, recorder?: LlmRecorder) {
  return extract("invoice", INVOICE_SYSTEM, text, InvoiceSchema, invoiceByRules, recorder);
}

export function readClaim(text: string, recorder?: LlmRecorder) {
  return extract("claim", CLAIM_SYSTEM, text, ClaimSchema, claimByRules, recorder);
}

/** Rule-based extraction for the no-key path. Same fields, same validation after. */
export function invoiceByRules(text: string): InvoiceFields {
  const grab = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? "";
  const amount = grab(/(?:Total due|Amount due|Total)\s*:?\s*(?:EUR|€)\s*([\d.,]+)/i).replace(/,(?=\d{3}\b)/g, "");
  return {
    invoice_id: grab(/Invoice (?:no\.?|number|#)\s*:?\s*([A-Z0-9-]+)/i),
    vendor: grab(/^From:\s*(.+)$/im),
    currency: /EUR|€/.test(text) ? "EUR" : "",
    amount,
    iban: grab(/IBAN\s*:?\s*([A-Z]{2}[0-9A-Z ]+)/i).replace(/\s+/g, ""),
    bic: grab(/(?:BIC|SWIFT)\s*:?\s*([A-Z0-9]{8,11})/i),
    due_date: grab(/Due(?: date)?\s*:?\s*(\d{4}-\d{2}-\d{2})/i),
    payment_reference: grab(/Reference\s*:?\s*([A-Za-z0-9-]+)/i),
  };
}

export function claimByRules(text: string): ClaimFields {
  const ids = [...new Set(text.match(/0x[0-9a-fA-F]{64}|stl_[0-9a-f]+/g) ?? [])];
  const issue = /stale|old|outdated|lag/i.test(text)
    ? "stale_data"
    : /wrong|incorrect|bad data/i.test(text)
      ? "wrong_data"
      : /never|not delivered|no data/i.test(text)
        ? "not_delivered"
        : /twice|duplicate/i.test(text)
          ? "duplicate_charge"
          : "other";
  return { charges: ids, claimed_issue: issue, summary: text.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "" };
}
