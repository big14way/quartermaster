import { useEffect, useRef, useState } from "react";

export type Role = "sourcing" | "support" | "treasury";

export interface QmEvent {
  seq: number;
  type: string;
  actor: string;
  at: string;
  data: Record<string, any>;
  hash: string;
  prev_hash: string;
}

export interface Step {
  id: string;
  title: string;
  narration: string;
}

export interface Meta {
  mode: "offline" | "live";
  runId: string;
  replay: boolean;
  steps: Step[];
  keyring: string;
  explorer: string;
}

export interface RoleLive {
  role: Role;
  mandateId: string;
  cap: string;
  budget: string;
  spent: string;
  payees: string[] | null;
  revoked: boolean;
  versions: number;
}

export interface Live {
  mode: string;
  ready: boolean;
  replay?: boolean;
  error?: string;
  account?: { account: string; owner: string; ramp: string };
  totalAllocation: string;
  balance?: string;
  block?: number;
  roles?: Record<Role, RoleLive>;
  sumBudgets?: string;
  sumRemaining?: string;
  invariants?: { id: string; ok: boolean; title: string; detail: string }[];
  suppliers?: { id: string; name: string; address: string; price: string; listed: boolean; healthy: boolean }[];
  supplier?: string;
  sourcingPaused?: boolean;
  usdPerEur?: string;
  invoice?: { id: string; vendor: string; amount: string; dueAt: string; paid: boolean };
  awx?: { currency: string; available_amount: string }[];
  plan?: { planId: string; status: string; option?: string };
  story?: { running?: string; done: string[]; error?: string };
}

export function useMeta(): Meta | undefined {
  const [meta, setMeta] = useState<Meta>();
  useEffect(() => {
    fetch("/api/meta")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => undefined);
  }, []);
  return meta;
}

export function useLive(intervalMs = 1500): Live | undefined {
  const [live, setLive] = useState<Live>();
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/live");
        if (alive) setLive(await r.json());
      } catch {
        /* controller restarting */
      }
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return live;
}

/** Every event from the start of the run, then new ones as they are appended. */
export function useEvents(): QmEvent[] {
  const [events, setEvents] = useState<QmEvent[]>([]);
  const last = useRef(0);
  useEffect(() => {
    let es: EventSource | undefined;
    let buffer: QmEvent[] = [];
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      const batch = buffer;
      buffer = [];
      setEvents((prev) => [...prev, ...batch]);
    };
    const connect = () => {
      es = new EventSource(`/api/stream?since=${last.current}`);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as QmEvent;
        if (e.seq <= last.current) return;
        last.current = e.seq;
        buffer.push(e);
        if (timer === undefined) timer = window.setTimeout(flush, 120);
      };
      es.onerror = () => {
        es?.close();
        setTimeout(connect, 1500);
      };
    };
    connect();
    return () => es?.close();
  }, []);
  return events;
}

export async function runStep(step: string) {
  await fetch(`/api/story/${step}`, { method: "POST" });
}

export async function runReconcile() {
  await fetch("/api/reconcile", { method: "POST" });
}
