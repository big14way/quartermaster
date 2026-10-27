import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, http, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { writeMip20Contract } from "@metalntwx/metal-ts";
import { verifyMandatePayment } from "@metalntwx/metal-pay/mandates";
import { QmError, baseUnitsToCents, centsToBaseUnits, fromCents, type Address, type Cents, type MandateStatus, type MandateTerms } from "@qm/core";
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
  /**
   * A funded testnet key that pays for setup instead of the faucet (one grant a minute and
   * ten a day per IP). With it, funding sends exact amounts by plain USDZ transfer.
   */
  funderKeyFile?: string;
}

const isRateLimited = (err: unknown) => /client_rate_limited|rate limit/i.test((err as Error).message ?? "");
const retryAfter = (err: unknown) => {
  const m = /retry in (\d+)\s*s|(\d+)\s*s/.exec((err as Error).message ?? "");
  return Number(m?.[1] ?? m?.[2] ?? 60);
};

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

/** metal-agent appends notes such as " (created)" to file paths. */
function pathOf(value: string | undefined): string | undefined {
  return value?.replace(/\s+\([^)]*\)\s*$/, "").trim();
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
    // spawn reports a missing cwd as ENOENT on the executable, so make sure it exists.
    mkdirSync(this.cfg.home, { recursive: true });
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
          reject(new QmError(refusalCode(msg), redact(msg, this.cfg.rpcUrl), { args: args[0], exit: run.code, nonce: first(run.lines, "nonce") }));
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

  /** Plain USDZ transfer from the funder key, waited to a receipt. */
  async transferFromFunder(to: Address, amount: Cents): Promise<string> {
    const key = JSON.parse(readFileSync(this.cfg.funderKeyFile!, "utf8")) as { privateKey: Hex };
    const transport = http(this.cfg.rpcUrl);
    const publicClient = createPublicClient({ transport });
    const walletClient = createWalletClient({ account: privateKeyToAccount(key.privateKey), transport });
    const hash = await writeMip20Contract({
      walletClient,
      publicClient,
      abi: erc20Abi,
      address: USDZ_ADDRESS,
      functionName: "transfer",
      args: [to, centsToBaseUnits(amount)],
      gasToken: USDZ_ADDRESS,
      gasFallback: 200_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new QmError("transfer_failed", `funding transfer ${hash} reverted`);
    return hash;
  }

  async createAccount() {
    const owner = this.ownerKey();
    if (this.cfg.funderKeyFile) {
      // Give the owner key its gas first, so account create never needs the faucet.
      const address = existsSync(owner) ? (JSON.parse(readFileSync(owner, "utf8")) as { address: Address }).address : await this.createKey(owner);
      if ((await this.balanceOf(address)) === 0n) await this.transferFromFunder(address, 10n);
    }
    const args = existsSync(owner) ? ["account", "create", "--key", owner, ...this.net()] : ["account", "create", "--out", owner, ...this.net()];
    let r: CliRun | undefined;
    for (let attempt = 1; !r; attempt++) {
      try {
        r = await this.run(args);
      } catch (err) {
        if (!isRateLimited(err) || attempt >= 4) throw err;
        await new Promise((res) => setTimeout(res, (retryAfter(err) + 2) * 1000));
        if (existsSync(owner)) args.splice(0, args.length, "account", "create", "--key", owner, ...this.net());
      }
    }
    return {
      account: need(r.lines, "account", "account create") as Address,
      owner: need(r.lines, "owner", "account create") as Address,
      tx: first(r.lines, "transaction"),
    };
  }

  /**
   * Fund an address: an exact transfer from the funder key when there is one, otherwise a
   * faucet grant (one a minute per client; waited out and retried).
   */
  async fund(address: Address, amount?: Cents) {
    if (this.cfg.funderKeyFile) {
      const amt = amount ?? 100n;
      return { tx: await this.transferFromFunder(address, amt), amount: amt };
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.run(["fund", address, ...this.net(false)]);
        const funded = first(r.lines, "funded");
        return { tx: first(r.lines, "transaction"), amount: funded ? usdzToCents(funded) : undefined, note: r.stdout.trim() };
      } catch (err) {
        if (!isRateLimited(err) || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, (retryAfter(err) + 2) * 1000));
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
      credentialPath: pathOf(first(r.lines, "credential")) ?? input.out,
      mandateKeyPath: pathOf(need(r.lines, "mandate-key-file", "credential create"))!,
      issuerKeyPath: pathOf(first(r.lines, "issuer-key-file")),
      issuerPublicPath: pathOf(need(r.lines, "issuer-public-file", "credential create"))!,
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
    // "payees any", or the listed addresses on "payees" / "payee" lines.
    const listed = [...(r.lines.get("payees") ?? []), ...(r.lines.get("payee") ?? [])]
      .flatMap((v) => v.match(/0x[0-9a-fA-F]{40}/g) ?? [])
      .map((a) => a as Address);
    return {
      mandateId: need(r.lines, "mandate", "status"),
      bound: first(r.lines, "bound") !== "no",
      revoked: (first(r.lines, "revoked") ?? "no") !== "no",
      spent: sb.spent,
      budget: sb.budget,
      cap: usdzToCents((first(r.lines, "per-payment-cap") ?? first(r.lines, "cap") ?? "0").split(/\s+/)[0]!),
      payees: listed.length ? listed : null,
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
    // "payment <tx> block N: 0.01 *USDZ to 0x…, nonce 0x…" and "refusal <tx> …: <reason>"
    const parse = (line: string, kind: "payment" | "refusal") => {
      const amount = /([\d.]+)\s*\*?USDZ/.exec(line)?.[1];
      return {
        kind,
        tx: /0x[0-9a-fA-F]{64}/.exec(line)?.[0] ?? line,
        to: / to (0x[0-9a-fA-F]{40})/.exec(line)?.[1],
        amount: amount ? usdzToCents(amount) : undefined,
        reason: kind === "refusal" ? refusalCode(line) : undefined,
      };
    };
    const payments = [...(r.lines.get("payment") ?? []).map((l) => parse(l, "payment")), ...(r.lines.get("refusal") ?? []).map((l) => parse(l, "refusal"))];
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
          return { status: 402, body: undefined, headers: {}, refusal: { code: refusalCode(msg), message: msg, stage, nonce: e.details?.nonce as string | undefined } };
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
