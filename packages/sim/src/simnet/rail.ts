import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  QmError,
  canonicalHash,
  centsToBaseUnits,
  fromCents,
  requestJson,
  toCents,
  type Address,
  type Cents,
  type MandateStatus,
  type MandateTerms,
} from "@qm/core";
import {
  DELIVERY_HEADER,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  decodeHeader,
  encodeHeader,
  exactOffer,
  type AgentRail,
  type CredentialInfo,
  type FacilitatorReader,
  type OwnerRail,
  type PaidResult,
  type PaymentRequired,
  type PaymentResponse,
  type Payer,
  type PullOutcome,
  type SettlementRow,
  type VerifyReport,
} from "@qm/metal";
import { encodeSignedOffer, mandateIdOf, type SimCredential, type SimCredentialBody, type SimPayment, type SimPaymentBody } from "./chain";
import { generateP256, publicOf, readJson, readKeyFile, signPayload, writeJson, writeKeyFile, type PrivateJwk } from "./keys";

export interface SimMetalConfig {
  simnetUrl: string;
  ownerKeyFile?: string;
}

const issuerFiles = (ownerKeyFile: string) => {
  const base = ownerKeyFile.replace(/\.json$/, "");
  return { key: `${base}.issuer.json`, pub: `${base}.issuer.public.json` };
};

/**
 * The simnet behind the same OwnerRail / AgentRail interfaces as the live CLI adapter.
 * Keys are real P-256 keys in files with the same custody rules: the owner and issuer
 * keys stay with the keyring, each mandate key with its agent.
 */
export class SimMetal implements OwnerRail, AgentRail, FacilitatorReader {
  constructor(private readonly cfg: SimMetalConfig) {}

  private api<T>(path: string, body?: unknown): Promise<T> {
    return requestJson<T>(`${this.cfg.simnetUrl}${path}`, body === undefined ? {} : { body });
  }

  private ownerKey(): PrivateJwk {
    if (!this.cfg.ownerKeyFile) throw new QmError("no_owner_key", "this process holds no owner key");
    return readKeyFile(this.cfg.ownerKeyFile).jwk;
  }

  private auth(op: string, payload: unknown) {
    const at = Date.now();
    return { at, signature: signPayload(this.ownerKey(), { op, digest: canonicalHash(payload), at }) };
  }

  // ---- owner side ------------------------------------------------------------------

  async createAccount() {
    const file = this.cfg.ownerKeyFile;
    if (!file) throw new QmError("no_owner_key", "pass an owner key file");
    if (!existsSync(file)) writeKeyFile(file, "owner", generateP256());
    const r = await this.api<{ account: Address; owner: Address; transaction?: string }>("/account/create", { ownerKey: publicOf(this.ownerKey()) });
    return { account: r.account, owner: r.owner, tx: r.transaction };
  }

  async fund(address: Address, amount: Cents = 10_000n) {
    const r = await this.api<{ funded: string; transaction: string }>("/faucet", { address, amount: fromCents(amount) });
    return { tx: r.transaction, amount: toCents(r.funded) };
  }

  async balanceOf(address: Address): Promise<Cents> {
    const r = await this.api<{ usdz: string }>(`/balance/${address}`);
    return toCents(r.usdz);
  }

  async createCredential(input: { principal: Address; terms: MandateTerms; out: string; mandateKeyFile?: string; expiresInSeconds?: number }): Promise<CredentialInfo> {
    const owner = this.cfg.ownerKeyFile!;
    const iss = issuerFiles(owner);
    if (!existsSync(iss.key)) {
      const k = generateP256();
      writeKeyFile(iss.key, "issuer", k);
      writeJson(iss.pub, publicOf(k));
    }
    const issuer = readKeyFile(iss.key).jwk;
    const mandateKeyPath = input.mandateKeyFile ?? input.out.replace(/\.json$/, ".key.json");
    if (!existsSync(mandateKeyPath)) writeKeyFile(mandateKeyPath, "mandate", generateP256());
    const mandateKey = readKeyFile(mandateKeyPath).jwk;
    const now = Math.floor(Date.now() / 1000);
    const startOfDay = now - (now % 86_400);
    const body: SimCredentialBody = {
      format: "qm-sim-credential/1",
      principal: input.principal,
      terms: {
        cap: fromCents(input.terms.cap),
        budget: fromCents(input.terms.budget),
        payees: input.terms.payees,
        description: input.terms.description,
      },
      startsAt: startOfDay,
      expiresAt: now + (input.expiresInSeconds ?? 30 * 86_400),
      mandateKey: publicOf(mandateKey),
      issuer: publicOf(issuer),
      issuedAt: new Date().toISOString(),
      salt: randomBytes(8).toString("hex"),
    };
    const credential: SimCredential = { ...body, mandateId: mandateIdOf(body), signature: signPayload(issuer, body) };
    writeJson(input.out, credential);
    return {
      mandateId: credential.mandateId,
      principal: input.principal,
      terms: input.terms,
      credentialPath: input.out,
      mandateKeyPath,
      issuerKeyPath: iss.key,
      issuerPublicPath: iss.pub,
    };
  }

  async bind(credentialPath: string) {
    const credential = readJson<SimCredential>(credentialPath);
    const r = await this.api<{ transaction: string }>("/mandate/bind", { credential, auth: this.auth("bind", credential) });
    return { tx: r.transaction, explorer: this.explorer(r.transaction) };
  }

  async replace(credentialPath: string, replacesPath: string) {
    const credential = readJson<SimCredential>(credentialPath);
    const replacesId = readJson<SimCredential>(replacesPath).mandateId;
    const r = await this.api<{ transaction: string; spent: string }>("/mandate/replace", {
      credential,
      replaces: replacesId,
      auth: this.auth("replace", { credential, replacesId }),
    });
    return { tx: r.transaction, explorer: this.explorer(r.transaction), spent: toCents(r.spent) };
  }

  async revoke(credentialPath: string) {
    const mandateId = readJson<SimCredential>(credentialPath).mandateId;
    const r = await this.api<{ transaction: string }>("/mandate/revoke", { mandateId, auth: this.auth("revoke", { mandateId }) });
    return { tx: r.transaction, explorer: this.explorer(r.transaction) };
  }

  // ---- agent side ------------------------------------------------------------------

  async status(credentialPath: string): Promise<MandateStatus> {
    const c = readJson<SimCredential>(credentialPath);
    try {
      const m = await this.api<{ revoked: boolean; spent: string; payments: number; terms: SimCredential["terms"] }>(`/mandate/${c.mandateId}`);
      return {
        mandateId: c.mandateId,
        bound: true,
        revoked: m.revoked,
        spent: toCents(m.spent),
        budget: toCents(m.terms.budget),
        cap: toCents(m.terms.cap),
        payees: m.terms.payees?.map((p) => p.address) ?? null,
        payments: m.payments,
      };
    } catch (err) {
      if ((err as QmError).code !== "mandate_not_bound") throw err;
      return { mandateId: c.mandateId, bound: false, revoked: false, spent: 0n, budget: toCents(c.terms.budget), cap: toCents(c.terms.cap), payees: null, payments: 0 };
    }
  }

  private signPayment(credentialPath: string, mandateKeyPath: string, to: Address, amountBase: string): SimPayment {
    const c = readJson<SimCredential>(credentialPath);
    const now = Math.floor(Date.now() / 1000);
    const body: SimPaymentBody = {
      mandateId: c.mandateId,
      principal: c.principal,
      to,
      amount: amountBase,
      nonce: `0x${randomBytes(32).toString("hex")}`,
      validAfter: now - 5,
      validBefore: now + 600,
    };
    return { ...body, signature: signPayload(readKeyFile(mandateKeyPath).jwk, body) };
  }

  async pull(input: { credentialPath: string; mandateKeyPath: string; to: Address; amount: Cents; paymentId: string; recordRefusalWithKey?: string }): Promise<PullOutcome> {
    const payment = this.signPayment(input.credentialPath, input.mandateKeyPath, input.to, centsToBaseUnits(input.amount).toString());
    const r = await this.api<{
      outcome: "paid" | "refused";
      transaction?: string;
      spent?: string;
      budget?: string;
      payee?: Address;
      amount?: string;
      repeated?: boolean;
      reason?: string;
      recorded?: boolean;
    }>("/mandate/pull", { payment, paymentId: input.paymentId, recordRefusal: !!input.recordRefusalWithKey, submitter: input.recordRefusalWithKey ? "agent-gas-key" : "facilitator" });
    if (r.outcome === "paid") {
      return {
        outcome: "paid",
        tx: r.transaction!,
        spent: toCents(r.spent!),
        budget: toCents(r.budget!),
        amount: toCents(r.amount!),
        payee: r.payee!,
        explorer: this.explorer(r.transaction!),
        repeated: r.repeated,
      };
    }
    return { outcome: "refused", reason: r.reason!, recorded: !!r.recorded, tx: r.transaction };
  }

  async verify(input: { credentialPath: string; issuerPublicPaths: string[]; tx?: string; signedOffer?: string }): Promise<VerifyReport> {
    const credential = readJson<SimCredential>(input.credentialPath);
    const issuers = input.issuerPublicPaths.map((p) => readJson(p));
    return this.api<VerifyReport>("/mandate/verify", { credential, issuers, tx: input.tx, signedOffer: input.signedOffer });
  }

  verifyPayment(input: { tx: string; signedOffer: string }): Promise<VerifyReport> {
    return this.api<VerifyReport>("/mandate/verify-payment", input);
  }

  payer(credentialPath: string, mandateKeyPath: string): Payer {
    return {
      pay: async (url, init = {}): Promise<PaidResult> => {
        const method = init.method ?? (init.body === undefined ? "GET" : "POST");
        const baseHeaders: Record<string, string> = { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers };
        const body = init.body === undefined ? undefined : JSON.stringify(init.body);
        const first = await fetch(url, { method, headers: baseHeaders, body });
        if (first.status !== 402) return { status: first.status, body: await readBody(first), headers: headersOf(first) };
        const offer = exactOffer(decodeHeader<PaymentRequired>(first.headers.get(HEADER_REQUIRED)));
        await first.arrayBuffer();
        if (!offer) return { status: 402, body: undefined, headers: {}, refusal: { code: "no_exact_offer", message: "no exact USDZ offer on Metal", stage: "before-signing" } };

        const payment = this.signPayment(credentialPath, mandateKeyPath, offer.payTo, offer.requirement.amount);
        let signedOffer: string | undefined;
        if (offer.signedOrderRequired) {
          const so = {
            resource: offer.resource ?? offer.payTo,
            amount: offer.requirement.amount,
            payTo: offer.payTo,
            network: offer.network,
            mandateId: payment.mandateId,
            issuedAt: Date.now(),
          };
          signedOffer = encodeSignedOffer(so, signPayload(readKeyFile(mandateKeyPath).jwk, so));
        }
        const payload = {
          x402Version: 2,
          accepted: offer.requirement,
          payload: { authorization: payment },
          extensions: { "metal-mandate": { ref: payment.mandateId, checkoutMandate: signedOffer ?? "" } },
        };
        const second = await fetch(url, { method, headers: { ...baseHeaders, [HEADER_SIGNATURE]: encodeHeader(payload) }, body });
        const resBody = await readBody(second);
        if (second.status === 402) {
          const err = decodeHeader<PaymentRequired>(second.headers.get(HEADER_REQUIRED))?.error ?? "payment_refused";
          return {
            status: 402,
            body: resBody,
            headers: headersOf(second),
            refusal: { code: err, message: `payment refused: ${err}; nothing was paid`, stage: err === "settlement_in_doubt" ? "in-doubt" : "verify" },
          };
        }
        const pr = decodeHeader<PaymentResponse>(second.headers.get(HEADER_RESPONSE));
        if (!pr?.transaction) {
          return { status: second.status, body: resBody, headers: headersOf(second), refusal: { code: "not_charged", message: `seller answered ${second.status} without settling`, stage: "seller" } };
        }
        return {
          status: second.status,
          body: resBody,
          headers: headersOf(second),
          paid: { tx: pr.transaction, amount: offer.price, payee: offer.payTo, mandateId: payment.mandateId, signedOffer, nonce: payment.nonce },
        };
      },
    };
  }

  async settlements(payTo: Address, since?: number): Promise<SettlementRow[]> {
    const q = new URLSearchParams({ payTo, ...(since !== undefined ? { since: String(since) } : {}) });
    const r = await this.api<{ settlements: SettlementRow[] }>(`/x402/facilitator/settlements?${q}`);
    return r.settlements;
  }

  explorer(tx: string): string {
    return `${this.cfg.simnetUrl}/tx/${tx}`;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k] = v));
  delete out[DELIVERY_HEADER.toLowerCase()];
  return { ...out, ...(res.headers.get(DELIVERY_HEADER) ? { [DELIVERY_HEADER]: res.headers.get(DELIVERY_HEADER)! } : {}) };
}
