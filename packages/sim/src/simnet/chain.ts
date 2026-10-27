import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  QmError,
  baseUnitsToCents,
  canonicalHash,
  centsToBaseUnits,
  fromCents,
  toCents,
  type Address,
  type Cents,
} from "@qm/core";
import { addressOfKey, randomHex32, sameKey, verifyPayload, type PublicJwk } from "./keys";

export const SIM_NETWORK = "eip155:63825";
export const SIM_ASSET = "0x000000000000000000000000000000000000B5d5";

// ---- wire types ---------------------------------------------------------------------

export interface SimCredentialBody {
  format: "qm-sim-credential/1";
  principal: Address;
  terms: { cap: string; budget: string; payees: { address: Address; name?: string; website?: string }[] | null; description?: string };
  startsAt: number;
  expiresAt: number;
  mandateKey: PublicJwk;
  issuer: PublicJwk;
  issuedAt: string;
  salt: string;
}

export interface SimCredential extends SimCredentialBody {
  mandateId: string;
  /** Issuer's signature over the body. */
  signature: string;
}

/** A per-payment mandate: the agent's key over payee, amount and validity window. */
export interface SimPaymentBody {
  mandateId: string;
  principal: Address;
  to: Address;
  /** Base units, 18 decimals. */
  amount: string;
  nonce: string;
  validAfter: number;
  validBefore: number;
}

export interface SimPayment extends SimPaymentBody {
  signature: string;
}

export interface OwnerAuth {
  /** Owner key signature over { op, digest, at }. */
  signature: string;
  at: number;
}

export type TxKind = "faucet" | "account" | "bind" | "replace" | "renew" | "revoke" | "payment" | "refusal" | "transfer";

export interface SimTx {
  hash: string;
  kind: TxKind;
  block: number;
  at: number;
  from?: Address;
  to?: Address;
  amount?: string;
  mandateId?: string;
  reason?: string;
  submitter?: string;
  payment?: SimPayment;
  meta?: Record<string, unknown>;
}

interface MandateRecord {
  credential: SimCredential;
  credentialHash: string;
  boundTx: string;
  boundBlock: number;
  spent: string;
  payments: string[];
  refusals: string[];
  revoked: boolean;
  revokedBlock?: number;
  successor?: string;
}

interface AccountRecord {
  address: Address;
  owner: Address;
  ownerKey: PublicJwk;
  createdTx: string;
}

export interface SettlementRecord {
  id: string;
  network: string;
  scheme: string;
  payer: string;
  payTo: string;
  amount: string;
  transaction: string;
  settledAt: number;
  nonce: string;
}

interface State {
  block: number;
  balances: Record<string, string>;
  accounts: Record<string, AccountRecord>;
  mandates: Record<string, MandateRecord>;
  txs: Record<string, SimTx>;
  pullIds: Record<string, string>;
  nonces: Record<string, string>;
  settlements: SettlementRecord[];
  faults: { nextSettle?: "settlement_in_doubt" };
}

const emptyState = (): State => ({
  block: 1,
  balances: {},
  accounts: {},
  mandates: {},
  txs: {},
  pullIds: {},
  nonces: {},
  settlements: [],
  faults: {},
});

export type PullResult =
  | { outcome: "paid"; tx: SimTx; spent: Cents; budget: Cents; repeated: boolean }
  | { outcome: "refused"; reason: string; recorded: boolean; tx?: SimTx };

export function credentialBodyOf(c: SimCredential): SimCredentialBody {
  const { mandateId: _m, signature: _s, ...body } = c;
  return body;
}

export function mandateIdOf(body: SimCredentialBody): string {
  return `0x${canonicalHash(body)}`;
}

export function paymentBodyOf(p: SimPayment): SimPaymentBody {
  const { signature: _s, ...body } = p;
  return body;
}

/**
 * An in-process stand-in for Metal testnet: USDZ balances, owner accounts that hold
 * mandates, and the account-side checks each payment must pass. Refusal codes match
 * Metal's. State persists to a JSON file so a restart keeps the chain.
 */
export class SimChain {
  private s: State;

  constructor(private readonly file?: string) {
    this.s = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State) : emptyState();
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.s));
  }

  private mine(tx: Omit<SimTx, "hash" | "block" | "at">): SimTx {
    this.s.block += 1;
    const at = Date.now();
    const hash = `0x${canonicalHash({ ...tx, block: this.s.block, at, salt: randomHex32() })}`;
    const full: SimTx = { ...tx, hash, block: this.s.block, at };
    this.s.txs[hash] = full;
    return full;
  }

  private bal(addr: string): bigint {
    return BigInt(this.s.balances[addr.toLowerCase()] ?? "0");
  }

  private setBal(addr: string, v: bigint) {
    this.s.balances[addr.toLowerCase()] = v.toString();
  }

  // ---- reads ------------------------------------------------------------------------

  get block() {
    return this.s.block;
  }

  balanceOf(addr: string): Cents {
    return baseUnitsToCents(this.bal(addr), "down");
  }

  tx(hash: string): SimTx | undefined {
    return this.s.txs[hash];
  }

  account(addr: string): AccountRecord | undefined {
    return this.s.accounts[addr.toLowerCase()];
  }

  mandate(id: string): (MandateRecord & { mandateId: string }) | undefined {
    const m = this.s.mandates[id];
    return m ? { ...m, mandateId: id } : undefined;
  }

  settlements(payTo: string, since = 0): SettlementRecord[] {
    return this.s.settlements.filter((r) => r.payTo.toLowerCase() === payTo.toLowerCase() && r.settledAt >= since).slice(0, 500);
  }

  setFault(f: State["faults"]) {
    this.s.faults = f;
    this.save();
  }

  // ---- funding and accounts ---------------------------------------------------------

  faucet(addr: Address, amount: Cents): SimTx {
    this.setBal(addr, this.bal(addr) + centsToBaseUnits(amount));
    const tx = this.mine({ kind: "faucet", to: addr, amount: centsToBaseUnits(amount).toString(), submitter: "faucet" });
    this.save();
    return tx;
  }

  /** A plain transfer from a key-held address (used for an owner topping up its account). */
  transfer(from: Address, to: Address, amount: Cents): SimTx {
    const base = centsToBaseUnits(amount);
    if (this.bal(from) < base) throw new QmError("transfer_would_fail", "insufficient balance");
    this.setBal(from, this.bal(from) - base);
    this.setBal(to, this.bal(to) + base);
    const tx = this.mine({ kind: "transfer", from, to, amount: base.toString(), submitter: from });
    this.save();
    return tx;
  }

  createAccount(ownerKey: PublicJwk): { account: AccountRecord; tx?: SimTx } {
    const owner = addressOfKey(ownerKey);
    const address = addressOfKey(ownerKey, "metal-account:");
    const existing = this.s.accounts[address];
    if (existing) return { account: existing };
    const tx = this.mine({ kind: "account", to: address, submitter: owner });
    const account: AccountRecord = { address, owner, ownerKey, createdTx: tx.hash };
    this.s.accounts[address] = account;
    this.save();
    return { account, tx };
  }

  private requireOwner(principal: Address, op: string, payload: unknown, auth: OwnerAuth): AccountRecord {
    const acct = this.account(principal);
    if (!acct) throw new QmError("not_a_metal_account", `${principal} is not a Metal account`);
    if (Math.abs(Date.now() - auth.at) > 5 * 60_000) throw new QmError("owner_auth_expired", "owner signature too old");
    const ok = verifyPayload(acct.ownerKey, { op, digest: canonicalHash(payload), at: auth.at }, auth.signature);
    if (!ok) throw new QmError("owner_bad_signature", `owner signature does not match ${acct.owner}`);
    return acct;
  }

  private checkCredential(c: SimCredential) {
    const body = credentialBodyOf(c);
    if (mandateIdOf(body) !== c.mandateId) throw new QmError("credential_bad_id", "mandate id does not match the credential");
    if (!verifyPayload(c.issuer, body, c.signature)) throw new QmError("credential_bad_signature", "issuer signature invalid");
  }

  // ---- owner operations -------------------------------------------------------------

  bind(credential: SimCredential, auth: OwnerAuth): SimTx {
    this.checkCredential(credential);
    const acct = this.requireOwner(credential.principal, "bind", credential, auth);
    if (this.s.mandates[credential.mandateId]) throw new QmError("mandate_already_bound", "this credential is already bound");
    const tx = this.mine({ kind: "bind", to: acct.address, mandateId: credential.mandateId, submitter: acct.owner });
    this.s.mandates[credential.mandateId] = {
      credential,
      credentialHash: canonicalHash(credential),
      boundTx: tx.hash,
      boundBlock: tx.block,
      spent: "0",
      payments: [],
      refusals: [],
      revoked: false,
    };
    this.save();
    return tx;
  }

  /** Bind a new credential and revoke the old one in one transaction. Spend carries over unless renewing. */
  replace(credential: SimCredential, replacesId: string, auth: OwnerAuth, renew = false): { tx: SimTx; spent: Cents } {
    this.checkCredential(credential);
    const acct = this.requireOwner(credential.principal, renew ? "renew" : "replace", { credential, replacesId }, auth);
    const old = this.s.mandates[replacesId];
    if (!old) throw new QmError("mandate_not_bound", "the mandate to replace is not bound");
    if (old.revoked) throw new QmError("mandate_revoked", "the mandate to replace is already revoked");
    if (old.credential.principal !== credential.principal) throw new QmError("principal_mismatch", "replacement names another account");
    if (this.s.mandates[credential.mandateId]) throw new QmError("mandate_already_bound", "this credential is already bound");
    const carried = renew ? 0n : BigInt(old.spent);
    const newBudget = centsToBaseUnits(toCents(credential.terms.budget));
    if (newBudget < carried) {
      throw new QmError("mandate_budget_below_spent", `new budget ${credential.terms.budget} is below the ${fromCents(baseUnitsToCents(carried))} already spent`);
    }
    const tx = this.mine({
      kind: renew ? "renew" : "replace",
      to: acct.address,
      mandateId: credential.mandateId,
      submitter: acct.owner,
      meta: { replaces: replacesId },
    });
    old.revoked = true;
    old.revokedBlock = tx.block;
    old.successor = credential.mandateId;
    this.s.mandates[credential.mandateId] = {
      credential,
      credentialHash: canonicalHash(credential),
      boundTx: tx.hash,
      boundBlock: tx.block,
      spent: carried.toString(),
      payments: [],
      refusals: [],
      revoked: false,
    };
    this.save();
    return { tx, spent: baseUnitsToCents(carried) };
  }

  revoke(mandateId: string, auth: OwnerAuth): SimTx {
    const m = this.s.mandates[mandateId];
    if (!m) throw new QmError("mandate_not_bound", "mandate not bound");
    const acct = this.requireOwner(m.credential.principal, "revoke", { mandateId }, auth);
    const tx = this.mine({ kind: "revoke", to: acct.address, mandateId, submitter: acct.owner });
    m.revoked = true;
    m.revokedBlock = tx.block;
    this.save();
    return tx;
  }

  // ---- payments ---------------------------------------------------------------------

  /** The account-side checks, in Metal's order. Returns a refusal code or undefined. */
  check(p: SimPayment, now = Math.floor(Date.now() / 1000)): string | undefined {
    const m = this.s.mandates[p.mandateId];
    if (!m || m.credential.principal.toLowerCase() !== p.principal.toLowerCase()) return "mandate_not_bound";
    if (m.revoked) return "mandate_revoked";
    if (!verifyPayload(m.credential.mandateKey, paymentBodyOf(p), p.signature)) return "mandate_bad_signature";
    if (now < p.validAfter || now > p.validBefore) return "mandate_outside_window";
    if (now > m.credential.expiresAt) return "mandate_expired";
    if (now < m.credential.startsAt) return "mandate_outside_recurrence";
    const payees = m.credential.terms.payees;
    if (payees && !payees.some((x) => x.address.toLowerCase() === p.to.toLowerCase())) return "mandate_payee_not_listed";
    const amount = BigInt(p.amount);
    if (amount % centsToBaseUnits(1n) !== 0n) return "mandate_cap_exceeded";
    if (amount > centsToBaseUnits(toCents(m.credential.terms.cap))) return "mandate_cap_exceeded";
    if (BigInt(m.spent) + amount > centsToBaseUnits(toCents(m.credential.terms.budget))) return "mandate_budget_spent";
    if (this.s.nonces[p.nonce]) return "mandate_nonce_used";
    if (this.bal(p.principal) < amount) return "transfer_would_fail";
    return undefined;
  }

  /** The account's pull: check the limits, move the funds, spend the budget. */
  pull(p: SimPayment, opts: { paymentId?: string; recordRefusal?: boolean; submitter?: string } = {}): PullResult {
    const pullKey = opts.paymentId ? `${p.mandateId}:${opts.paymentId}` : undefined;
    if (pullKey && this.s.pullIds[pullKey]) {
      const tx = this.s.txs[this.s.pullIds[pullKey]!]!;
      const m = this.s.mandates[p.mandateId]!;
      return { outcome: "paid", tx, spent: baseUnitsToCents(BigInt(m.spent)), budget: toCents(m.credential.terms.budget), repeated: true };
    }
    const reason = this.check(p);
    const m = this.s.mandates[p.mandateId];
    if (reason) {
      if (opts.recordRefusal && m) {
        const tx = this.mine({ kind: "refusal", from: p.principal, to: p.to, amount: p.amount, mandateId: p.mandateId, reason, payment: p, submitter: opts.submitter });
        m.refusals.push(tx.hash);
        this.save();
        return { outcome: "refused", reason, recorded: true, tx };
      }
      return { outcome: "refused", reason, recorded: false };
    }
    const amount = BigInt(p.amount);
    this.setBal(p.principal, this.bal(p.principal) - amount);
    this.setBal(p.to, this.bal(p.to) + amount);
    m!.spent = (BigInt(m!.spent) + amount).toString();
    this.s.nonces[p.nonce] = p.mandateId;
    const tx = this.mine({ kind: "payment", from: p.principal, to: p.to, amount: p.amount, mandateId: p.mandateId, payment: p, submitter: opts.submitter ?? "facilitator" });
    m!.payments.push(tx.hash);
    if (pullKey) this.s.pullIds[pullKey] = tx.hash;
    this.save();
    return { outcome: "paid", tx, spent: baseUnitsToCents(BigInt(m!.spent)), budget: toCents(m!.credential.terms.budget), repeated: false };
  }

  // ---- facilitator ------------------------------------------------------------------

  facilitatorVerify(p: SimPayment, req: { amount: string; payTo: string; network: string }): { isValid: boolean; invalidReason?: string; payer: string } {
    if (req.network !== SIM_NETWORK) return { isValid: false, invalidReason: "unsupported_network", payer: p.principal };
    if (req.amount !== p.amount) return { isValid: false, invalidReason: "payment_mismatch:amount", payer: p.principal };
    if (req.payTo.toLowerCase() !== p.to.toLowerCase()) return { isValid: false, invalidReason: "payment_mismatch:payTo", payer: p.principal };
    if (this.s.nonces[p.nonce]) return { isValid: false, invalidReason: "nonce_already_used", payer: p.principal };
    const reason = this.check(p);
    return reason ? { isValid: false, invalidReason: reason, payer: p.principal } : { isValid: true, payer: p.principal };
  }

  facilitatorSettle(p: SimPayment, req: { amount: string; payTo: string; network: string }) {
    const prior = this.s.settlements.find((s) => s.nonce === p.nonce);
    if (prior) {
      return { success: true, transaction: prior.transaction, network: SIM_NETWORK, payer: p.principal, extra: { settlement: { id: prior.id, first: false } } };
    }
    const v = this.facilitatorVerify(p, req);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: "", network: SIM_NETWORK, payer: p.principal };
    const res = this.pull(p, { submitter: "facilitator" });
    if (res.outcome !== "paid") return { success: false, errorReason: res.reason, transaction: "", network: SIM_NETWORK, payer: p.principal };
    const row: SettlementRecord = {
      id: `stl_${res.tx.hash.slice(2, 18)}`,
      network: SIM_NETWORK,
      scheme: "exact",
      payer: p.principal,
      payTo: p.to,
      amount: p.amount,
      transaction: res.tx.hash,
      settledAt: Date.now(),
      nonce: p.nonce,
    };
    this.s.settlements.push(row);
    const fault = this.s.faults.nextSettle;
    if (fault) {
      this.s.faults.nextSettle = undefined;
      this.save();
      // The transfer landed but the receipt "timed out": the payer must look it up before paying again.
      return { success: false, errorReason: fault, transaction: "", network: SIM_NETWORK, payer: p.principal };
    }
    this.save();
    return { success: true, transaction: res.tx.hash, network: SIM_NETWORK, payer: p.principal, extra: { settlement: { id: row.id, first: true } } };
  }

  // ---- verification -----------------------------------------------------------------

  /** Mirror of `mandate verify`: four checks using only chain state plus the credential and issuer keys in hand. */
  verify(credential: SimCredential, issuers: PublicJwk[], opts: { tx?: string; signedOffer?: string } = {}) {
    const m = this.s.mandates[credential.mandateId];
    const steps: { step: number; outcome: "pass" | "fail" | "skipped"; title: string; detail?: string }[] = [];
    const s1 = !!m && m.credential.principal === credential.principal;
    steps.push({ step: 1, outcome: s1 ? "pass" : "fail", title: "Mandate bound on the principal's account", detail: s1 ? `bound in block ${m!.boundBlock}` : "no binding found" });
    const s2 = !!m && m.credentialHash === canonicalHash(credential);
    steps.push({ step: 2, outcome: !m ? "skipped" : s2 ? "pass" : "fail", title: "Credential matches the bound hash, limits, payees and key" });
    let s3 = false;
    if (m) {
      try {
        this.checkCredential(credential);
        s3 = issuers.some((i) => sameKey(i, credential.issuer)) && sameKey(m.credential.issuer, credential.issuer);
      } catch {
        s3 = false;
      }
    }
    steps.push({ step: 3, outcome: !m ? "skipped" : s3 ? "pass" : "fail", title: "Issuer signature under a trusted key recorded at binding" });

    const payments: { kind: "payment" | "refusal"; tx: string; to?: string; amount?: Cents; reason?: string; ok: boolean }[] = [];
    if (m) {
      let running = 0n;
      const hashes = [...m.payments, ...m.refusals].filter((h) => !opts.tx || h === opts.tx);
      for (const h of hashes.sort((a, b) => this.s.txs[a]!.block - this.s.txs[b]!.block)) {
        const t = this.s.txs[h]!;
        const p = t.payment!;
        const sigOk = verifyPayload(m.credential.mandateKey, paymentBodyOf(p), p.signature);
        if (t.kind === "payment") running += BigInt(p.amount);
        const capOk = BigInt(p.amount) <= centsToBaseUnits(toCents(m.credential.terms.cap));
        const ok = t.kind === "refusal" ? sigOk : sigOk && capOk;
        payments.push({ kind: t.kind === "refusal" ? "refusal" : "payment", tx: h, to: t.to, amount: baseUnitsToCents(BigInt(p.amount)), reason: t.reason, ok });
      }
      if (opts.tx && !hashes.length) payments.push({ kind: "payment", tx: opts.tx, ok: false, reason: "not a payment under this mandate" });
    }
    let offerOk = true;
    if (opts.signedOffer && m) offerOk = verifySignedOfferAgainst(opts.signedOffer, m.credential.mandateKey, opts.tx ? this.s.txs[opts.tx] : undefined);
    const s4 = !!m && payments.every((p) => p.ok) && offerOk;
    steps.push({
      step: 4,
      outcome: !m ? "skipped" : s4 ? "pass" : "fail",
      title: "Each payment and refusal is the mandate key's, inside the mandate at its block",
      detail: `${payments.length} checked${opts.signedOffer ? `, signed order ${offerOk ? "matches" : "does not match"}` : ""}`,
    });
    return { verified: steps.every((s) => s.outcome === "pass"), mandateId: credential.mandateId, steps, payments };
  }
}

// ---- signed orders --------------------------------------------------------------------

export interface SignedOfferBody {
  resource: string;
  amount: string;
  payTo: string;
  network: string;
  mandateId: string;
  issuedAt: number;
}

export function encodeSignedOffer(body: SignedOfferBody, signature: string): string {
  return `qmso1.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${signature}`;
}

export function decodeSignedOffer(text: string): { body: SignedOfferBody; signature: string } | undefined {
  const [tag, b, sig] = text.split(".");
  if (tag !== "qmso1" || !b || !sig) return undefined;
  try {
    return { body: JSON.parse(Buffer.from(b, "base64url").toString()) as SignedOfferBody, signature: sig };
  } catch {
    return undefined;
  }
}

export function verifySignedOfferAgainst(text: string, mandateKey: PublicJwk, tx?: SimTx): boolean {
  const d = decodeSignedOffer(text);
  if (!d || !verifyPayload(mandateKey, d.body, d.signature)) return false;
  if (tx?.payment) return d.body.amount === tx.payment.amount && d.body.payTo.toLowerCase() === tx.payment.to.toLowerCase();
  return true;
}
