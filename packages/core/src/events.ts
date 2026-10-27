import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalHash, canonicalJson } from "./canonical";

export const GENESIS_HASH = "0".repeat(64);

export interface EventInput {
  type: string;
  actor: string;
  data: Record<string, unknown>;
  /** Wall-clock override, used by replays so hashes reproduce. */
  at?: string;
}

export interface QmEvent extends Required<EventInput> {
  seq: number;
  prev_hash: string;
  hash: string;
}

export function hashEvent(e: Omit<QmEvent, "hash">): string {
  return canonicalHash({ seq: e.seq, type: e.type, actor: e.actor, at: e.at, data: e.data, prev_hash: e.prev_hash });
}

/**
 * Append-only, hash-chained event log. Each line of the JSONL file is one event whose
 * `prev_hash` is the previous event's hash, so editing or dropping any line breaks the
 * chain from that point on. LLM inputs and outputs are logged here too, which makes a
 * replay deterministic.
 */
export class EventLog {
  private seq = 0;
  private last = GENESIS_HASH;
  private readonly listeners = new Set<(e: QmEvent) => void>();
  readonly events: QmEvent[] = [];

  constructor(readonly file?: string) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) {
        for (const e of readEvents(file)) this.ingest(e);
      }
    }
  }

  append(input: EventInput): QmEvent {
    const base = {
      seq: this.seq + 1,
      type: input.type,
      actor: input.actor,
      at: input.at ?? new Date().toISOString(),
      // Round-trip through canonical JSON so bigint and undefined are stored the way they hash.
      data: JSON.parse(canonicalJson(input.data)) as Record<string, unknown>,
      prev_hash: this.last,
    };
    const event: QmEvent = { ...base, hash: hashEvent(base) };
    if (this.file) appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.ingest(event);
    for (const fn of this.listeners) fn(event);
    return event;
  }

  subscribe(fn: (e: QmEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get head(): string {
    return this.last;
  }

  private ingest(e: QmEvent) {
    this.events.push(e);
    this.seq = e.seq;
    this.last = e.hash;
  }
}

export function readEvents(file: string): QmEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as QmEvent);
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  head: string;
  brokenAt?: number;
  reason?: string;
}

export function verifyChain(events: QmEvent[]): ChainCheck {
  let prev = GENESIS_HASH;
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1) return { ok: false, count: events.length, head: prev, brokenAt: e.seq, reason: "sequence gap" };
    if (e.prev_hash !== prev) return { ok: false, count: events.length, head: prev, brokenAt: e.seq, reason: "prev_hash mismatch" };
    const { hash, ...rest } = e;
    if (hashEvent(rest) !== hash) return { ok: false, count: events.length, head: prev, brokenAt: e.seq, reason: "hash mismatch" };
    prev = hash;
  }
  return { ok: true, count: events.length, head: prev };
}
