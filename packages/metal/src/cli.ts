import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createPublicClient, erc20Abi, http, type Hash } from "viem";
import { verifyMandatePayment } from "@metalntwx/metal-pay/mandates";
import { QmError, baseUnitsToCents, fromCents, type Address, type Cents, type MandateStatus, type MandateTerms } from "@qm/core";
import {
  USDZ_ADDRESS,
  type AgentRail,
  type CredentialInfo,
  type FacilitatorReader,
  type OwnerRail,
  type PaidResult,
  type Payer,
  type PullOutcome,
  type SettlementRow,
  type VerifyReport,
} from "./rail";
import { refusalCode, usdzToCents } from "./x402";

export interface LiveMetalConfig {
  rpcUrl: string;
  facilitatorUrl: string;
  faucetUrl?: string;
  /** Owner key file. Only the keyring passes this. */
  ownerKeyFile?: string;
  /** Working directory for the CLI. Its HOME is set here too, so pull records stay per agent. */
  home: string;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  lines: Map<string, string[]>;
}

/** `name value` output lines, as metal-agent prints them, grouped by name. */
export function parseNameValue(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const i = line.indexOf(" ");
    const name = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1);
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

function first(lines: Map<string, string[]>, name: string): string | undefined {
  return lines.get(name)?.[0];
}

function need(lines: Map<string, string[]>, name: string, ctx: string): string {
  const v = first(lines, name);
  if (v === undefined) throw new QmError("metal_cli_output", `${ctx}: missing "${name}" line`);
  return v;
}

/** "6.5 *USDZ of 10 *USDZ" → { spent, budget } */
export function parseSpent(text: string): { spent: Cents; budget: Cents } {
  const m = /^([\d.]+)\s*\*?USDZ\s+of\s+([\d.]+)\s*\*?USDZ/i.exec(text.trim());
  if (!m) throw new QmError("metal_cli_output", `cannot parse spend "${text}"`);
  return { spent: usdzToCents(m[1]!), budget: usdzToCents(m[2]!) };
}

const cliEntry = (() => {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@metalntwx/metal-agent/package.json")), "dist", "index.js");
})();

/**
 * Metal testnet through the `metal-agent` CLI. Every call names the network and RPC
 * endpoint explicitly; the endpoint id is a credential, so it never reaches a log line.
 */
export class LiveMetal implements OwnerRail, AgentRail, FacilitatorReader {
  constructor(private readonly cfg: LiveMetalConfig) {}

  async run(args: string[], opts: { allowExit?: number[] } = {}): Promise<CliRun> {
    const env = {
      ...process.env,
      HOME: this.cfg.home,
      METAL_RPC_URL: this.cfg.rpcUrl,
      METAL_FACILITATOR_URL: this.cfg.facilitatorUrl,
      ...(this.cfg.faucetUrl ? { METAL_FAUCET_URL: this.cfg.faucetUrl } : {}),
    };
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntry, ...args], { cwd: this.cfg.home, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        const run = { code: code ?? 1, stdout, stderr, lines: parseNameValue(stdout) };
        if (run.code !== 0 && !(opts.allowExit ?? []).includes(run.code)) {
          const msg = (stderr.match(/error: (.*)/)?.[1] ?? stderr.trim()) || `exit ${run.code}`;
          reject(new QmError(refusalCode(msg), redact(msg, this.cfg.rpcUrl), { args: args[0], exit: run.code }));
          return;
        }
        resolve(run);
      });
    });
  }

  private net(withRpc = true): string[] {
    return withRpc ? ["--network", "testnet", "--rpc-url", this.cfg.rpcUrl] : ["--network", "testnet"];
  }

  private ownerKey(): string {
    if (!this.cfg.ownerKeyFile) throw new QmError("no_owner_key", "this process holds no owner key");
    return this.cfg.ownerKeyFile;
  }

  // ---- owner side ------------------------------------------------------------------

  async createAccount() {
    const r = await this.run(["account", "create", "--out", this.ownerKey(), ...this.net()]);
    return {
      account: need(r.lines, "account", "account create") as Address,
      owner: need(r.lines, "owner", "account create") as Address,
      tx: first(r.lines, "transaction"),
    };
  }

  /** Faucet grant. The faucet allows one grant a minute per client; wait it out and retry. */
  async fund(address: Address) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.run(["fund", address, ...this.net(false)]);
        const funded = first(r.lines, "funded");
        return { tx: first(r.lines, "transaction"), amount: funded ? usdzToCents(funded) : undefined, note: r.stdout.trim() };
      } catch (err) {
        const msg = (err as Error).message;
        if (!/client_rate_limited|rate limit/i.test(msg) || attempt >= 4) throw err;
        const wait = Number(/(\d+)\s*s/.exec(msg)?.[1] ?? 60);
        await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
      }
    }
  }

  /** A plain key that pays its own gas, e.g. for recording a refused payout on chain. */
  async createKey(out: string): Promise<Address> {
    const r = await this.run(["key", "create", "--out", out]);
    return need(r.lines, "address", "key create") as Address;
  }

  async balanceOf(address: Address): Promise<Cents> {
    const client = createPublicClient({ transport: http(this.cfg.rpcUrl) });
    const base = await client.readContract({ address: USDZ_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    return baseUnitsToCents(base, "down");
  }

  async createCredential(input: { principal: Address; terms: MandateTerms; out: string; mandateKeyFile?: string; expiresInSeconds?: number }) {
    const args = [
      "mandate",
      "credential",
      "create",
      "--principal",
      input.principal,
      "--cap",
      fromCents(input.terms.cap),
      "--budget",
      fromCents(input.terms.budget),
      "--out",
      input.out,
      "--key",
      this.ownerKey(),
      ...this.net(),
    ];
    for (const p of input.terms.payees ?? []) args.push("--payee", [p.address, p.name, p.website].filter(Boolean).join(","));
    if (input.mandateKeyFile) args.push("--mandate-key-file", input.mandateKeyFile);
    if (input.terms.description) args.push("--description", input.terms.description);
    if (input.expiresInSeconds) args.push("--expires-in", String(input.expiresInSeconds));
    const r = await this.run(args);
    const info: CredentialInfo = {
      mandateId: need(r.lines, "mandate", "credential create"),
      principal: input.principal,
      terms: input.terms,
      credentialPath: first(r.lines, "credential") ?? input.out,
      mandateKeyPath: need(r.lines, "mandate-key-file", "credential create"),
      issuerKeyPath: first(r.lines, "issuer-key-file"),
      issuerPublicPath: need(r.lines, "issuer-public-file", "credential create"),
    };
    return info;
  }

  async bind(credentialPath: string) {
    const r = await this.run(["mandate", "bind", "--credential", credentialPath, "--key", this.ownerKey(), ...this.net()]);
    return { tx: need(r.lines, "transaction", "bind"), explorer: first(r.lines, "explorer"), gas: first(r.lines, "gas") };
  }

  async replace(credentialPath: string, replacesPath: string) {
    const r = await this.run([
      "mandate",
      "replace",
      "--credential",
      credentialPath,
      "--replaces",
      replacesPath,
      "--key",
      this.ownerKey(),
      ...this.net(),
    ]);
    const spentLine = first(r.lines, "spent") ?? "0";
    const spent = /of/.test(spentLine) ? parseSpent(spentLine).spent : usdzToCents(spentLine);
    return { tx: need(r.lines, "transaction", "replace"), explorer: first(r.lines, "explorer"), gas: first(r.lines, "gas"), spent };
  }

  async revoke(credentialPath: string) {
    const r = await this.run(["mandate", "revoke", "--credential", credentialPath, "--key", this.ownerKey(), ...this.net()]);
    return { tx: need(r.lines, "transaction", "revoke"), explorer: first(r.lines, "explorer") };
  }

  // ---- agent side ------------------------------------------------------------------

  async status(credentialPath: string): Promise<MandateStatus> {
    const r = await this.run(["mandate", "status", "--credential", credentialPath, ...this.net()]);
    const spentLine = first(r.lines, "spent");
    const sb = spentLine ? parseSpent(spentLine) : { spent: 0n, budget: usdzToCents(first(r.lines, "budget") ?? "0") };
    const payees = r.lines.get("payee")?.map((p) => p.split(/[ ,]/)[0] as Address) ?? null;
    return {
      mandateId: need(r.lines, "mandate", "status"),
      bound: first(r.lines, "bound") !== "no",
      revoked: (first(r.lines, "revoked") ?? "no") !== "no",
      spent: sb.spent,
      budget: sb.budget,
      cap: usdzToCents(first(r.lines, "cap") ?? "0"),
      payees: payees && payees.length ? payees : null,
      payments: Number(first(r.lines, "payments") ?? "0"),
    };
  }

  async pull(input: { credentialPath: string; mandateKeyPath: string; to: Address; amount: Cents; paymentId: string; recordRefusalWithKey?: string }): Promise<PullOutcome> {
    const args = [
      "mandate",
      "pull",
      "--credential",
      input.credentialPath,
      "--mandate-key-file",
      input.mandateKeyPath,
      "--to",
      input.to,
      "--amount",
      fromCents(input.amount),
      "--payment-id",
      input.paymentId,
      ...this.net(),
      "--facilitator-url",
      this.cfg.facilitatorUrl,
    ];
    if (input.recordRefusalWithKey) args.push("--key", input.recordRefusalWithKey, "--record-refusal");
    // Exit codes: 0 paid, 1 refused, 3 pending, 4 held.
    const r = await this.run(args, { allowExit: [1, 3, 4] });
    const outcome = first(r.lines, "outcome") ?? "";
    if (r.code === 0 && outcome.startsWith("paid")) {
      const { spent, budget } = parseSpent(need(r.lines, "spent", "pull"));
      return {
        outcome: "paid",
        tx: need(r.lines, "transaction", "pull"),
        spent,
        budget,
        amount: usdzToCents(need(r.lines, "amount", "pull")),
        payee: need(r.lines, "payee", "pull") as Address,
        explorer: first(r.lines, "explorer"),
        repeated: /already paid/.test(r.stdout),
      };
    }
    if (r.code === 3) return { outcome: "pending", reason: first(r.lines, "reason") ?? "pending", canLandUntil: first(r.lines, "can-land-until") };
    if (r.code === 4) return { outcome: "held", tx: first(r.lines, "transaction") };
    const reason = first(r.lines, "reason") ?? refusalCode(r.stderr);
    return { outcome: "refused", reason: refusalCode(reason), recorded: (first(r.lines, "recorded") ?? "no") !== "no", tx: first(r.lines, "transaction") };
  }

  async verify(input: { credentialPath: string; issuerPublicPaths: string[]; tx?: string; signedOffer?: string }): Promise<VerifyReport> {
    const args = ["mandate", "verify", "--credential", input.credentialPath, ...this.net()];
    for (const i of input.issuerPublicPaths) args.push("--issuer", i);
    if (input.tx) args.push("--tx", input.tx);
    if (input.signedOffer) args.push("--signed-offer", input.signedOffer);
    const r = await this.run(args, { allowExit: [1] });
    const steps = (r.lines.get("step") ?? []).map((s) => {
      const m = /^(\d+)\s+(pass|fail|skipped):\s*(.*)$/.exec(s);
      return { step: Number(m?.[1] ?? 0), outcome: (m?.[2] ?? "fail") as "pass" | "fail" | "skipped", title: m?.[3] ?? s };
    });
    const payments = [...(r.lines.get("payment") ?? []), ...(r.lines.get("refusal") ?? [])].map((p) => {
      const tx = /0x[0-9a-fA-F]{64}/.exec(p)?.[0] ?? p;
      return { kind: (r.lines.get("refusal") ?? []).includes(p) ? ("refusal" as const) : ("payment" as const), tx, reason: refusalCode(p) };
    });
    return { verified: first(r.lines, "verified") === "yes", mandateId: first(r.lines, "mandate"), steps, payments, raw: r.stdout };
  }

  async verifyPayment(input: { tx: string; signedOffer: string }): Promise<VerifyReport> {
    const client = createPublicClient({ transport: http(this.cfg.rpcUrl) });
    const v = await verifyMandatePayment(client as never, { tx: input.tx as Hash, checkoutMandate: input.signedOffer });
    return {
      verified: v.ok,
      mandateId: v.mandate?.ref,
      steps: v.steps.map((s) => ({ step: s.step, outcome: s.outcome, title: s.title, detail: s.detail })),
      payments: v.payments.map((p) => ({ kind: p.kind, tx: p.txHash, to: p.to, amount: baseUnitsToCents(p.amount, "up"), reason: p.reason })),
    };
  }

  payer(credentialPath: string, mandateKeyPath: string): Payer {
    return {
      pay: async (url, init = {}): Promise<PaidResult> => {
        const args = ["pay", url, "--mandate", credentialPath, "--mandate-key-file", mandateKeyPath, ...this.net()];
        if (init.method) args.push("--method", init.method);
        if (init.body !== undefined) args.push("--body", JSON.stringify(init.body));
        for (const [k, v] of Object.entries(init.headers ?? {})) args.push("--header", `${k}: ${v}`);
        try {
          const r = await this.run(args);
          const headers: Record<string, string> = {};
          for (const h of r.lines.get("header") ?? []) {
            const i = h.indexOf(":");
            if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
          }
          const bodyIdx = r.stdout.search(/^body /m);
          const bodyText = bodyIdx >= 0 ? r.stdout.slice(bodyIdx + 5).trim() : "";
          let body: unknown = bodyText;
          try {
            body = JSON.parse(bodyText);
          } catch {
            /* plain text */
          }
          return {
            status: Number(first(r.lines, "status") ?? 200),
            body,
            headers,
            paid: {
              tx: need(r.lines, "transaction", "pay"),
              amount: usdzToCents(need(r.lines, "amount", "pay")),
              payee: need(r.lines, "payee", "pay") as Address,
              mandateId: first(r.lines, "mandate"),
              signedOffer: first(r.lines, "signed-offer"),
              nonce: first(r.lines, "nonce"),
            },
          };
        } catch (err) {
          const e = err as QmError;
          const msg = e.message ?? String(err);
          const stage = /before signing/.test(msg)
            ? "before-signing"
            : /in doubt/.test(msg)
              ? "in-doubt"
              : /at settlement/.test(msg)
                ? "settle"
                : "verify";
          return { status: 402, body: undefined, headers: {}, refusal: { code: refusalCode(msg), message: msg, stage } };
        }
      },
    };
  }

  // ---- facilitator ------------------------------------------------------------------

  async settlements(payTo: Address, since?: number): Promise<SettlementRow[]> {
    const rows: SettlementRow[] = [];
    let cursor = since;
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ payTo, ...(cursor !== undefined ? { since: String(cursor) } : {}) });
      const res = await fetch(`${this.cfg.facilitatorUrl}/settlements?${q}`);
      if (!res.ok) throw new QmError("facilitator_error", `settlements returned ${res.status}`);
      const body = (await res.json()) as { settlements: SettlementRow[] };
      const fresh = body.settlements.filter((s) => !rows.some((r) => r.id === s.id));
      rows.push(...fresh);
      if (body.settlements.length < 500 || !fresh.length) break;
      cursor = body.settlements[body.settlements.length - 1]!.settledAt;
    }
    return rows;
  }
}

function redact(message: string, rpcUrl: string): string {
  return rpcUrl ? message.split(rpcUrl).join("[RPC URL hidden]") : message;
}
