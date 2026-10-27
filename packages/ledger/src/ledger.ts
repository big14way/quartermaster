import { QmError, toJson, type Cents } from "@qm/core";
import { openDb, tx, type Db } from "./db";

/** Chart of accounts. Amounts are signed cents: positive debits, negative credits. */
export const ACCOUNTS = {
  metalAccount: "metal:account",
  rampInTransit: "metal:ramp_in_transit",
  awxUSD: "awx:USD",
  awxEUR: "awx:EUR",
  sales: "income:sales",
  sourcing: "expense:sourcing",
  refunds: "expense:refunds",
  awxFees: "expense:awx_fees",
  licence: "expense:licence",
  licencePayable: "liability:licence_payable",
  rampClearing: "clearing:ramp",
  fxClearing: "clearing:fx",
  capital: "equity:capital",
} as const;

export type Currency = "USDZ" | "USD" | "EUR";

export interface Line {
  account: string;
  currency: Currency;
  amount: Cents;
}

export interface PostInput {
  /** Kind of external effect, e.g. metal:settlement, metal:pull, awx:deposit, awx:transfer. */
  source: string;
  /** Unique id of the effect within its source: a settlement id, tx hash, transfer id. */
  externalId: string;
  memo: string;
  lines: Line[];
  data?: Record<string, unknown>;
  at?: string;
}

export interface Entry {
  id: number;
  source: string;
  externalId: string;
  memo: string;
  postedAt: string;
  lines: Line[];
  data: Record<string, unknown>;
}

export interface PostResult {
  posted: boolean;
  entryId: number;
}

/**
 * Double-entry ledger in integer cents. Every entry balances per currency, and every
 * external effect is unique by (source, external_id), so replays and retries of the same
 * effect never post twice.
 */
export class Ledger {
  readonly db: Db;

  constructor(fileOrDb: string | Db = ":memory:") {
    this.db = typeof fileOrDb === "string" ? openDb(fileOrDb) : fileOrDb;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        memo TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        UNIQUE (source, external_id)
      );
      CREATE TABLE IF NOT EXISTS lines (
        entry_id INTEGER NOT NULL REFERENCES entries(id),
        account TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lines_account ON lines(account, currency);
    `);
  }

  post(input: PostInput): PostResult {
    validate(input);
    const existing = this.db
      .prepare("SELECT id FROM entries WHERE source = ? AND external_id = ?")
      .get(input.source, input.externalId) as { id: number } | undefined;
    if (existing) return { posted: false, entryId: existing.id };

    return tx(this.db, () => {
      const res = this.db
        .prepare("INSERT INTO entries (source, external_id, memo, posted_at, data) VALUES (?, ?, ?, ?, ?)")
        .run(input.source, input.externalId, input.memo, input.at ?? new Date().toISOString(), toJson(input.data ?? {}));
      const entryId = Number(res.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO lines (entry_id, account, currency, amount) VALUES (?, ?, ?, ?)");
      for (const l of input.lines) ins.run(entryId, l.account, l.currency, l.amount);
      return { posted: true, entryId };
    });
  }

  has(source: string, externalId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM entries WHERE source = ? AND external_id = ?").get(source, externalId);
  }

  balance(account: string, currency: Currency): Cents {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM lines WHERE account = ? AND currency = ?")
      .get(account, currency) as { total: number | bigint };
    return BigInt(row.total);
  }

  /** Sum of all lines for an account prefix, e.g. "expense:" in USDZ. */
  balancePrefix(prefix: string, currency: Currency): Cents {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM lines WHERE account LIKE ? AND currency = ?")
      .get(`${prefix}%`, currency) as { total: number | bigint };
    return BigInt(row.total);
  }

  trialBalance(): { account: string; currency: Currency; balance: Cents }[] {
    const rows = this.db
      .prepare("SELECT account, currency, SUM(amount) AS balance FROM lines GROUP BY account, currency ORDER BY account, currency")
      .all() as { account: string; currency: Currency; balance: number | bigint }[];
    return rows.map((r) => ({ account: r.account, currency: r.currency, balance: BigInt(r.balance) }));
  }

  entries(source?: string): Entry[] {
    const rows = (
      source
        ? this.db.prepare("SELECT * FROM entries WHERE source = ? ORDER BY id").all(source)
        : this.db.prepare("SELECT * FROM entries ORDER BY id").all()
    ) as { id: number; source: string; external_id: string; memo: string; posted_at: string; data: string }[];
    const lineStmt = this.db.prepare("SELECT account, currency, amount FROM lines WHERE entry_id = ?");
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      externalId: r.external_id,
      memo: r.memo,
      postedAt: r.posted_at,
      data: JSON.parse(r.data) as Record<string, unknown>,
      lines: (lineStmt.all(r.id) as { account: string; currency: Currency; amount: number | bigint }[]).map((l) => ({
        account: l.account,
        currency: l.currency,
        amount: BigInt(l.amount),
      })),
    }));
  }
}

function validate(input: PostInput) {
  if (!input.lines.length) throw new QmError("ledger_empty", "an entry needs lines");
  const perCcy = new Map<string, bigint>();
  for (const l of input.lines) {
    if (typeof l.amount !== "bigint") throw new QmError("ledger_type", `amount for ${l.account} must be bigint cents`);
    perCcy.set(l.currency, (perCcy.get(l.currency) ?? 0n) + l.amount);
  }
  for (const [ccy, total] of perCcy) {
    if (total !== 0n) {
      throw new QmError("ledger_unbalanced", `entry ${input.source}/${input.externalId} is off by ${total} ${ccy} cents`);
    }
  }
}
