import type { Express, Request } from "express";
import type { Address, Cents } from "@qm/core";

export interface PaidRoute {
  method: "GET" | "POST";
  /** Express path, e.g. "/v1/snapshot". */
  path: string;
  /** The line item a signed order names, e.g. "GET /v1/snapshot". */
  resource: string;
  description: string;
  payTo: Address;
  /** Read on every request, so a price change takes effect on the next 402. */
  price: () => Cents;
  signedOrder: boolean;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  /** Id of what was delivered; the sale hook receives it to store beside the signed order. */
  deliveryId?: string;
}

export type RouteHandler = (req: Request) => Promise<HandlerResult>;

/** A settled payment, reported once per settlement with `first` telling if it is new. */
export interface Sale {
  settlementId: string;
  first: boolean;
  tx: string;
  payer: string;
  amount: Cents;
  resource: string;
  signedOffer?: string;
  mandateId?: string;
  deliveryId?: string;
}

/**
 * The seller side of x402. Verify, then run the handler, then settle only if the handler
 * returned a status below 400. A refused or failed request is never charged.
 */
export interface Paywall {
  mount(app: Express, route: PaidRoute, handler: RouteHandler): void;
  onSale(fn: (sale: Sale) => Promise<void> | void): void;
}

export const DELIVERY_HEADER = "x-qm-delivery";
