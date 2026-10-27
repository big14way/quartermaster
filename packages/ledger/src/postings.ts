import type { Cents } from "@qm/core";
import { ACCOUNTS as A, type PostInput } from "./ledger";

/** Builders for every business event Quartermaster books. Each returns a balanced entry. */
export const postings = {
  funding(txHash: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "metal:funding",
      externalId: txHash,
      memo: "Account funded",
      lines: [
        { account: A.metalAccount, currency: "USDZ", amount },
        { account: A.capital, currency: "USDZ", amount: -amount },
      ],
      data,
    };
  },

  sale(settlementId: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "metal:settlement",
      externalId: settlementId,
      memo: "Query sold",
      lines: [
        { account: A.metalAccount, currency: "USDZ", amount },
        { account: A.sales, currency: "USDZ", amount: -amount },
      ],
      data,
    };
  },

  sourcing(txHash: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "metal:sourcing",
      externalId: txHash,
      memo: "Upstream data bought under mandate S",
      lines: [
        { account: A.sourcing, currency: "USDZ", amount },
        { account: A.metalAccount, currency: "USDZ", amount: -amount },
      ],
      data,
    };
  },

  refund(txHash: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "metal:refund",
      externalId: txHash,
      memo: "Buyer refunded under mandate R",
      lines: [
        { account: A.refunds, currency: "USDZ", amount },
        { account: A.metalAccount, currency: "USDZ", amount: -amount },
      ],
      data,
    };
  },

  sweep(txHash: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "metal:sweep",
      externalId: txHash,
      memo: "Earnings swept to the Airwallex ramp under mandate T",
      lines: [
        { account: A.rampInTransit, currency: "USDZ", amount },
        { account: A.metalAccount, currency: "USDZ", amount: -amount },
      ],
      data,
    };
  },

  /** The deposit landed in the USD Global Account; USDZ in transit becomes USD 1:1. */
  depositSettled(depositId: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "awx:deposit",
      externalId: depositId,
      memo: "Ramp deposit settled in the USD Global Account",
      lines: [
        { account: A.rampInTransit, currency: "USDZ", amount: -amount },
        { account: A.rampClearing, currency: "USDZ", amount },
        { account: A.rampClearing, currency: "USD", amount: -amount },
        { account: A.awxUSD, currency: "USD", amount },
      ],
      data,
    };
  },

  invoiceBooked(invoiceId: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "invoice:booked",
      externalId: invoiceId,
      memo: "Licence fee invoice booked",
      lines: [
        { account: A.licence, currency: "EUR", amount },
        { account: A.licencePayable, currency: "EUR", amount: -amount },
      ],
      data,
    };
  },

  conversion(conversionId: string, sellUSD: Cents, buyEUR: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "awx:conversion",
      externalId: conversionId,
      memo: "USD converted to EUR",
      lines: [
        { account: A.awxUSD, currency: "USD", amount: -sellUSD },
        { account: A.fxClearing, currency: "USD", amount: sellUSD },
        { account: A.fxClearing, currency: "EUR", amount: -buyEUR },
        { account: A.awxEUR, currency: "EUR", amount: buyEUR },
      ],
      data,
    };
  },

  transferPaid(transferId: string, amount: Cents, fee: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "awx:transfer",
      externalId: `${transferId}:paid`,
      memo: "Licence fee paid",
      lines: [
        { account: A.licencePayable, currency: "EUR", amount },
        { account: A.awxFees, currency: "EUR", amount: fee },
        { account: A.awxEUR, currency: "EUR", amount: -(amount + fee) },
      ],
      data,
    };
  },

  /** A late FAILED after PAID reverses the payment; the fee is kept by the rail. */
  transferReversed(transferId: string, amount: Cents, data: Record<string, unknown> = {}): PostInput {
    return {
      source: "awx:transfer",
      externalId: `${transferId}:reversed`,
      memo: "Licence fee transfer failed after PAID; funds returned",
      lines: [
        { account: A.awxEUR, currency: "EUR", amount },
        { account: A.licencePayable, currency: "EUR", amount: -amount },
      ],
      data,
    };
  },
};
