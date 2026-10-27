import type { Address, Cents, MandateStatus, MandateTerms } from "@qm/core";

export const METAL_NETWORK = "eip155:63825";
export const METAL_CHAIN_ID = 63825;
export const USDZ_ADDRESS: Address = "0x000000000000000000000000000000000000B5d5";

export interface CredentialInfo {
  mandateId: string;
  principal: Address;
  terms: MandateTerms;
  credentialPath: string;
  mandateKeyPath: string;
  issuerKeyPath?: string;
  issuerPublicPath: string;
}

export interface TxResult {
  tx: string;
  explorer?: string;
  gas?: string;
}

export type PullOutcome =
  | { outcome: "paid"; tx: string; spent: Cents; budget: Cents; amount: Cents; payee: Address; explorer?: string; repeated?: boolean }
  | { outcome: "refused"; reason: string; recorded: boolean; tx?: string }
  | { outcome: "pending"; reason: string; canLandUntil?: string }
  | { outcome: "held"; tx?: string };

export interface VerifyStep {
  step: number;
  outcome: "pass" | "fail" | "skipped";
  title: string;
  detail?: string;
}

export interface VerifyReport {
  verified: boolean;
  mandateId?: string;
  steps: VerifyStep[];
  payments: { kind: "payment" | "refusal"; tx: string; to?: string; amount?: Cents; reason?: string }[];
  raw?: string;
}

/** What a paid HTTP request returned. `refusal` is set when nothing was paid. */
export interface PaidResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  paid?: { tx: string; amount: Cents; payee: Address; mandateId?: string; signedOffer?: string; nonce?: string };
  refusal?: { code: string; message: string; stage: "before-signing" | "verify" | "settle" | "in-doubt" | "seller" };
}

/** Pays x402 routes under one mandate. The model using it can pick neither key nor limit. */
export interface Payer {
  pay(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<PaidResult>;
}

/** Owner-side operations. Only the keyring process ever constructs one of these. */
export interface OwnerRail {
  createAccount(): Promise<{ account: Address; owner: Address; tx?: string }>;
  /** Testnet faucet. `amount` is honoured by the simnet; the live faucet grants a fixed amount. */
  fund(address: Address, amount?: Cents): Promise<{ tx?: string; amount?: Cents; note?: string }>;
  balanceOf(address: Address): Promise<Cents>;
  createCredential(input: {
    principal: Address;
    terms: MandateTerms;
    out: string;
    /** Reuse the agent's existing mandate key, so the agent keeps paying with the key it holds. */
    mandateKeyFile?: string;
    expiresInSeconds?: number;
  }): Promise<CredentialInfo>;
  bind(credentialPath: string): Promise<TxResult>;
  /** Bind the new credential and revoke the old in one transaction; spend carries over. */
  replace(credentialPath: string, replacesPath: string): Promise<TxResult & { spent: Cents }>;
  revoke(credentialPath: string): Promise<TxResult>;
}

/** Agent-side operations, given only the agent's own credential and mandate key. */
export interface AgentRail {
  status(credentialPath: string): Promise<MandateStatus>;
  pull(input: {
    credentialPath: string;
    mandateKeyPath: string;
    to: Address;
    amount: Cents;
    paymentId: string;
    /** Submit with this gas key and record a refusal on chain if the mandate refuses. */
    recordRefusalWithKey?: string;
  }): Promise<PullOutcome>;
  verify(input: { credentialPath: string; issuerPublicPaths: string[]; tx?: string; signedOffer?: string }): Promise<VerifyReport>;
  /** Check one payment from the chain alone, and that the signed order is the one its mandate key signed. */
  verifyPayment(input: { tx: string; signedOffer: string }): Promise<VerifyReport>;
  payer(credentialPath: string, mandateKeyPath: string): Payer;
}

export interface SettlementRow {
  id: string;
  network: string;
  scheme: string;
  payer: string;
  payTo: string;
  amount: string;
  transaction: string;
  settledAt: number;
}

/** Read side of the facilitator, used by the reconciler. */
export interface FacilitatorReader {
  settlements(payTo: Address, since?: number): Promise<SettlementRow[]>;
}

export function explorerTx(base: string, tx: string): string {
  return `${base.replace(/\/$/, "")}/tx/${tx}`;
}
