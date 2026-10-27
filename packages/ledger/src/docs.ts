import { toJson } from "@qm/core";
import { openDb, type Db } from "./db";

/**
 * A small document store beside the ledger: sales with their signed orders, workflow
 * state machines, approvals. Documents are JSON; bigint fields are written as strings.
 */
export class DocStore {
  readonly db: Db;

  constructor(fileOrDb: string | Db = ":memory:") {
    this.db = typeof fileOrDb === "string" ? openDb(fileOrDb) : fileOrDb;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
    `);
  }

  put<T>(collection: string, id: string, doc: T): T {
    this.db
      .prepare(
        "INSERT INTO docs (collection, id, doc, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(collection, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
      )
      .run(collection, id, toJson(doc), new Date().toISOString());
    return doc;
  }

  /** Insert only if absent. Returns true when this call created the document. */
  create<T>(collection: string, id: string, doc: T): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO docs (collection, id, doc, updated_at) VALUES (?, ?, ?, ?)")
      .run(collection, id, toJson(doc), new Date().toISOString());
    return Number(res.changes) === 1;
  }

  get<T>(collection: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT doc FROM docs WHERE collection = ? AND id = ?").get(collection, id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as T) : undefined;
  }

  list<T>(collection: string): T[] {
    const rows = this.db
      .prepare("SELECT doc FROM docs WHERE collection = ? ORDER BY rowid")
      .all(collection) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  update<T>(collection: string, id: string, fn: (doc: T | undefined) => T): T {
    return this.put(collection, id, fn(this.get<T>(collection, id)));
  }
}
