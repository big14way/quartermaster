import { nextTransferStatus, type StatusUpdate, type TransferStatus, type WebhookEvent } from "@qm/airwallex";
import { callInternal } from "@qm/runtime";
import { toCents, varDir, type EventLog, type QmEvent } from "@qm/core";
import { DocStore, Ledger, postings, type PostInput } from "@qm/ledger";

const big = (v: unknown) => BigInt(String(v));

/**
 * The books: every event that moves money becomes a balanced ledger entry, unique by its
 * external id, and every Airwallex webhook is verified, deduplicated by event id and
 * applied through the monotonic transfer-status guard.
 */
export class Books {
  readonly ledger: Ledger;
  readonly docs: DocStore;

  constructor(private readonly bus: EventLog) {
    this.ledger = new Ledger(varDir("controller", "ledger.sqlite"));
    this.docs = new DocStore(varDir("controller", "docs.sqlite"));
  }

  private post(p: PostInput, event: QmEvent) {
    const r = this.ledger.post({ ...p, data: { ...p.data, event: event.seq } });
    if (r.posted) this.bus.append({ type: "ledger.posted", actor: "controller", data: { source: p.source, externalId: p.externalId, memo: p.memo, lines: p.lines, event: event.seq } });
  }

  onEvent(e: QmEvent) {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case "account.funded":
        if (d.amount) this.post(postings.funding(String(d.tx ?? "funding"), big(d.amount), { account: d.account }), e);
        break;
      case "sale.settled":
        this.post(postings.sale(String(d.settlementId), big(d.amount), { tx: d.tx, payer: d.payer }), e);
        break;
      case "sourcing.bought":
        this.post(postings.sourcing(String(d.tx), big(d.amount), { supplier: d.supplier }), e);
        break;
      case "refund.paid":
        this.post(postings.refund(String(d.tx), big(d.amount), { settlementId: d.settlementId }), e);
        void callInternal("seller", `/sales/${String(d.settlementId)}/refund`, { tx: d.tx }).catch(() => undefined);
        break;
      case "sweep.pulled":
        this.post(postings.sweep(String(d.tx), big(d.amount), { sweepId: d.sweepId }), e);
        break;
      case "invoice.booked":
        this.post(postings.invoiceBooked(String(d.id), big(d.amount), { vendor: d.vendor }), e);
        break;
      case "fx.converted":
        this.post(postings.conversion(String(d.conversionId), big(d.sellUSD), big(d.buyEUR), { requestId: d.requestId }), e);
        break;
    }
  }

  isSweepTx(tx: string): boolean {
    return this.ledger.has("metal:sweep", tx);
  }

  /** True once a settled deposit is booked. It is announced once, so a resumed run asks here. */
  depositBooked(depositId: string): boolean {
    return this.ledger.has("awx:deposit", depositId);
  }

  onWebhook(evt: WebhookEvent) {
    if (!this.docs.create("webhooks", evt.id, { name: evt.name, at: evt.created_at })) {
      this.bus.append({ type: "awx.webhook_duplicate", actor: "airwallex", data: { id: evt.id, name: evt.name } });
      return;
    }
    const o = evt.data.object as Record<string, string>;
    this.bus.append({ type: "awx.webhook", actor: "airwallex", data: { id: evt.id, name: evt.name, object: o.id ?? o.conversion_id } });
    if (evt.name === "deposit.settled") this.depositSettled(o, "webhook");
    if (evt.name === "conversion.settled") {
      this.post(postings.conversion(String(o.conversion_id), toCents(String(o.sell_amount)), toCents(String(o.buy_amount)), { requestId: o.request_id }), { seq: 0 } as QmEvent);
    }
    if (evt.name.startsWith("payout.transfer.")) this.applyTransfer(o, "webhook");
  }

  /** A settled deposit whose reference is one of our sweep tx hashes lands the sweep in USD. */
  depositSettled(o: Record<string, string>, via: "webhook" | "poll") {
    if (!this.isSweepTx(o.reference ?? "")) {
      if (via === "webhook") this.bus.append({ type: "awx.deposit_unmatched", actor: "controller", data: { depositId: o.id, reference: o.reference, amount: o.amount } });
      return;
    }
    if (this.ledger.has("awx:deposit", String(o.id))) return;
    const amount = toCents(String(o.amount));
    this.post(postings.depositSettled(String(o.id), amount, { reference: o.reference }), { seq: 0 } as QmEvent);
    this.bus.append({ type: "awx.deposit_settled", actor: "airwallex", data: { depositId: o.id, amount, currency: o.currency, reference: o.reference, via } });
  }

  /**
   * The poller half of webhook handling: webhooks can be lost or late, so the latest
   * Airwallex state is folded in through the same idempotent paths.
   */
  foldSnapshot(snap: { deposits: Record<string, string>[]; transfers: Record<string, string>[]; conversions: Record<string, string>[] }) {
    for (const d of snap.deposits) if (d.status === "SETTLED") this.depositSettled(d, "poll");
    for (const c of snap.conversions) {
      if (c.status === "SETTLED" || c.status === "SCHEDULED") {
        this.post(postings.conversion(String(c.conversion_id), toCents(String(c.sell_amount)), toCents(String(c.buy_amount)), { requestId: c.request_id }), { seq: 0 } as QmEvent);
      }
    }
    for (const t of snap.transfers) this.applyTransfer(t, "poll");
  }

  /** Apply a transfer status from a webhook or a poll, never moving backwards. */
  applyTransfer(o: Record<string, string>, via: "webhook" | "poll") {
    const current = this.docs.get<StatusUpdate & { paidPosted?: boolean }>("transfers", o.id!);
    const incoming: StatusUpdate = { status: o.status as TransferStatus, updated_at: o.updated_at! };
    const next = nextTransferStatus(current, incoming);
    const changed = !current || next.status !== current.status || next.updated_at !== current.updated_at;
    const ignored = next !== incoming;
    if (ignored && via === "webhook") {
      this.bus.append({
        type: "awx.transfer_status",
        actor: "airwallex",
        data: { transferId: o.id, status: incoming.status, ignored: true, kept: current?.status, why: `older than ${current?.status}; status never moves backwards` },
      });
    }
    if (!changed || ignored) return;
    this.docs.put("transfers", o.id!, { ...next, paidPosted: current?.paidPosted });
    this.bus.append({ type: "awx.transfer_status", actor: "airwallex", data: { transferId: o.id, status: next.status, previous: current?.status ?? null, via } });
    const fake = { seq: 0 } as QmEvent;
    if (next.status === "PAID") {
      this.post(postings.transferPaid(o.id!, toCents(String(o.transfer_amount)), toCents(String(o.fee_amount ?? "0")), { reference: o.reference }), fake);
      this.docs.put("transfers", o.id!, { ...next, paidPosted: true });
    }
    if (next.status === "FAILED" && current?.paidPosted) {
      this.post(postings.transferReversed(o.id!, toCents(String(o.transfer_amount)), { reason: o.failure_reason }), fake);
    }
  }

  transferStatus(id: string): TransferStatus | undefined {
    return this.docs.get<StatusUpdate>("transfers", id)?.status;
  }
}
