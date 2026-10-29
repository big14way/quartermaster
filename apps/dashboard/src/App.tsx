import { useMemo, type CSSProperties, type ReactNode } from "react";
import { runReconcile, runStep, useEvents, useLive, useMeta, type Live, type Meta, type QmEvent, type Role } from "./api";
import { describe } from "./describe";
import { LETTER, ROLE_JOB, ROLE_NAME, cents, decimalCents, money, pct, short, time } from "./format";

const ROLES: Role[] = ["sourcing", "support", "treasury"];

/** Short labels for the stepper; the full titles come from the controller. */
const STEP_LABEL: Record<string, string> = {
  setup: "Open accounts",
  sell: "Sell queries",
  spike: "Price rise",
  approve: "Approve",
  disputes: "Disputes",
  treasury: "Pay licence",
  drill: "Attack drill",
  close: "Close books",
};

const PATHS = {
  check: "M3.5 8.5l3 3 6-7",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  alert: "M8 2.6l5.8 10.4H2.2L8 2.6zM8 6.6v3M8 11.4v.2",
  lock: "M4.5 7.5h7v6h-7zM6 7.5V5.6a2 2 0 0 1 4 0v1.9",
  ext: "M6.5 3.5h6v6M12.5 3.5l-7 7",
  spark: "M8 2v12M2.8 5l10.4 6M2.8 11l10.4-6",
  shield: "M8 2l5 2v3.8c0 3.1-2.1 5.2-5 6.2-2.9-1-5-3.1-5-6.2V4l5-2z",
  bolt: "M9 1.8L3.5 9h4l-.6 5.2L12.5 7h-4L9 1.8z",
  arrow: "M3 8h10M9.5 4.5L13 8l-3.5 3.5",
} as const;

function I({ n, className }: { n: keyof typeof PATHS; className?: string }) {
  return (
    <svg className={`i ${className ?? ""}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d={PATHS[n]} />
    </svg>
  );
}

function Amt({ v, unit = "USDZ", signed }: { v: unknown; unit?: string; signed?: boolean }) {
  const c = cents(v);
  return (
    <span className="amt">
      {signed && c > 0n ? "+" : ""}
      {money(c, "")}
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

function Tx({ tx, meta, label }: { tx?: string; meta?: Meta; label?: string }) {
  if (!tx) return null;
  return (
    <a className="tx" href={`${meta?.explorer ?? ""}${tx}`} target="_blank" rel="noreferrer" title={tx}>
      {label ?? short(tx)}
      <I n="ext" />
    </a>
  );
}

function Pill({ tone = "muted", children, icon }: { tone?: "good" | "bad" | "warn" | "plan" | "muted" | "brand"; children: ReactNode; icon?: keyof typeof PATHS }) {
  return (
    <span className={`pill ${tone}`}>
      {icon && <I n={icon} />}
      {children}
    </span>
  );
}

const lastOf = (events: QmEvent[], type: string, pred?: (e: QmEvent) => boolean) => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === type && (!pred || pred(e))) return e;
  }
  return undefined;
};

/** The mark: one account drawn as three arcs, one per budget. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 36 36" aria-hidden="true">
      <rect x="0.5" y="0.5" width="35" height="35" rx="10" />
      <path className="arc s" d="M18.56 8.14A9 9 0 0 1 21.5 24.79" />
      <path className="arc r" d="M19.33 25.69A9 9 0 0 1 10.11 22.79" />
      <path className="arc t" d="M8.84 20.8A9 9 0 0 1 15.44 8.14" />
      <path className="tail" d="M21 21l6.2 6.2" />
    </svg>
  );
}

function Header({ meta, live, events }: { meta?: Meta; live?: Live; events: QmEvent[] }) {
  const last = events[events.length - 1];
  const status = !meta
    ? undefined
    : meta.replay
      ? { cls: "replay", label: "Replay", sub: "a recorded run, verified" }
      : meta.mode === "offline"
        ? { cls: "sim", label: "Simulated", sub: "Metal simnet · Airwallex simulator" }
        : meta.airwallex === "sim"
          ? { cls: "live", label: "Live", sub: "Metal testnet · Airwallex simulated" }
          : { cls: "live", label: "Live", sub: "Metal testnet · Airwallex sandbox" };
  return (
    <header className="top">
      <div className="brand">
        <Mark />
        <div>
          <h1>Quartermaster</h1>
          <p>Three x402 agents, one Metal account, budgets that rebalance when supplier prices move</p>
        </div>
      </div>
      <div className="status">
        {status && (
          <span className={`mode ${status.cls}`}>
            <span className="beacon" />
            <b>{status.label}</b>
            <span>{status.sub}</span>
          </span>
        )}
        <dl className="stats">
          <div>
            <dt>Block</dt>
            <dd className="mono">{live?.block ? live.block.toLocaleString("en-US") : "—"}</dd>
          </div>
          <div>
            <dt>Events</dt>
            <dd className="mono">{events.length}</dd>
          </div>
          <div>
            <dt>Log head</dt>
            <dd className="mono" title={last?.hash}>
              {last ? short(last.hash, 6, 4) : "—"}
            </dd>
          </div>
        </dl>
      </div>
    </header>
  );
}

function Story({ meta, live, events }: { meta?: Meta; live?: Live; events: QmEvent[] }) {
  const status = new Map<string, string>();
  for (const e of events) if (e.type === "story.step") status.set(e.data.id, e.data.status);
  const steps = meta?.steps ?? [];
  const running = live?.story?.running;
  const stateOf = (id: string) => (running === id || status.get(id) === "started" ? "running" : (status.get(id) ?? "pending"));
  const next = steps.find((s) => status.get(s.id) !== "done");
  const allDone = steps.length > 0 && !next;
  const current = steps.find((s) => s.id === running) ?? next ?? steps[steps.length - 1];
  const at = current ? steps.indexOf(current) : 0;
  const done = steps.filter((s) => status.get(s.id) === "done").length;
  return (
    <section className="card story">
      <div className="story-head">
        <div>
          <p className="eyebrow">{allDone ? "The story · complete" : `The story · step ${at + 1} of ${steps.length || 8}`}</p>
          <h2 className="story-title">{current?.title ?? "Loading…"}</h2>
        </div>
        {!meta?.replay && (
          <div className="actions">
            {next && (
              <button className="primary" disabled={!!running} onClick={() => runStep(next.id)}>
                {running ? (
                  <>
                    <span className="spin" /> Running
                  </>
                ) : (
                  <>
                    Run · {STEP_LABEL[next.id] ?? next.title} <I n="arrow" />
                  </>
                )}
              </button>
            )}
            <button className="ghost" disabled={!!running || !next} onClick={() => runStep("all")}>
              Run all
            </button>
          </div>
        )}
      </div>
      <ol className="stepper" style={{ "--done": steps.length > 1 ? Math.min(Math.max(done - (allDone ? 1 : 0), 0) / (steps.length - 1), 1) : 0 } as CSSProperties}>
        {steps.map((s, i) => {
          const st = stateOf(s.id);
          return (
            <li key={s.id} className={`${st} ${s === current && !allDone ? "current" : ""}`}>
              <span className="node">{st === "done" ? <I n="check" /> : st === "failed" ? "!" : st === "running" ? <span className="spin" /> : i + 1}</span>
              <span className="label">{STEP_LABEL[s.id] ?? s.title}</span>
            </li>
          );
        })}
      </ol>
      {current && <p className="narration">{current.narration}</p>}
      {live?.story?.error && (
        <p className="callout bad">
          <I n="alert" /> {live.story.error}
        </p>
      )}
    </section>
  );
}

function Account({ live }: { live?: Live }) {
  const total = cents(live?.totalAllocation ?? 2000);
  const roles = live?.roles;
  return (
    <section className="card account">
      <div className="account-head">
        <div className="kpi lead">
          <p className="eyebrow">Metal account balance, on chain</p>
          <p className="figure xl">
            <Amt v={live?.balance} />
          </p>
          <p className="sub mono">{live?.account ? short(live.account.account, 10, 8) : "no account yet"}</p>
        </div>
        <div className="kpi">
          <p className="eyebrow">Budgets allocated</p>
          <p className="figure lg">
            <Amt v={live?.sumBudgets} />
          </p>
          <p className="sub">of {money(total)} set aside</p>
        </div>
        <div className="kpi">
          <p className="eyebrow">Budgets remaining</p>
          <p className="figure lg">
            <Amt v={live?.sumRemaining} />
          </p>
          <p className="sub">The account caps each budget. Quartermaster holds the sum.</p>
        </div>
      </div>
      <div className="alloc" role="img" aria-label={`Budgets as a share of the ${money(total)} allocation`}>
        {roles &&
          ROLES.map((r) => {
            const b = cents(roles[r].budget);
            const s = cents(roles[r].spent);
            return (
              <div key={r} className={`seg ${r}`} style={{ width: `${pct(b, total)}%` }} title={`${ROLE_NAME[r]}: ${money(s)} spent of ${money(b)}`}>
                <div className="used" style={{ width: `${pct(s, b)}%` }} />
              </div>
            );
          })}
      </div>
      <div className="legend">
        {ROLES.map((r) => (
          <span key={r} className="key">
            <span className={`swatch ${r}`} />
            <b>{LETTER[r]}</b> {ROLE_NAME[r]}
            <span className="amt-sm">{money(roles?.[r].budget, "")}</span>
            <span className="muted">· {money(roles?.[r].spent, "")} spent</span>
          </span>
        ))}
      </div>
      {(live?.invariants?.length ?? 0) > 0 && (
      <div className="invariants">
        {(live?.invariants ?? []).map((i) => (
          <span key={i.id} className={`inv ${i.ok ? "ok" : "no"}`} title={i.detail}>
            <I n={i.ok ? "check" : "x"} />
            <b>{i.id}</b> {i.title}
          </span>
        ))}
      </div>
      )}
    </section>
  );
}

function Mandates({ live, events, meta }: { live?: Live; events: QmEvent[]; meta?: Meta }) {
  const bindTx = (r: Role) => lastOf(events, "mandate.replaced", (e) => e.data.role === r)?.data.tx ?? lastOf(events, "mandate.bound", (e) => e.data.role === r)?.data.tx;
  return (
    <div className="mandates">
      {ROLES.map((r) => {
        const m = live?.roles?.[r];
        const b = cents(m?.budget);
        const s = cents(m?.spent);
        return (
          <section key={r} className={`card mandate ${r}`}>
            <header>
              <span className={`avatar ${r}`}>{LETTER[r]}</span>
              <div>
                <h3>{ROLE_NAME[r]} agent</h3>
                <p>{ROLE_JOB[r]}</p>
              </div>
              <span className="ver" title="mandate versions">
                v{m?.versions ?? 0}
              </span>
            </header>
            <p className="figure lg">
              <Amt v={b - s} />
            </p>
            <p className="sub">left of {money(b)} budget</p>
            <div className="meter">
              <div style={{ width: `${pct(s, b)}%` }} />
            </div>
            <dl className="rows">
              <div>
                <dt>Cap per payment</dt>
                <dd>{money(m?.cap)}</dd>
              </div>
              <div>
                <dt>Spent</dt>
                <dd>{money(m?.spent)}</dd>
              </div>
              <div>
                <dt>Payees</dt>
                <dd>{m?.payees ? `${m.payees.length} listed` : "any payee"}</dd>
              </div>
            </dl>
            <footer>
              <span className="mono">{m ? short(m.mandateId, 8, 4) : "not bound"}</span>
              <Tx tx={bindTx(r)} meta={meta} label="bind tx" />
            </footer>
          </section>
        );
      })}
    </div>
  );
}

function Decision({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const opened = lastOf(events, "plan.opened");
  const initial = lastOf(events, "plan.initial");
  if (!opened) {
    return (
      <section className="card decision">
        <div className="card-head">
          <div>
            <p className="eyebrow">Plan</p>
            <h2>{initial ? "The opening split" : "No plan yet"}</h2>
          </div>
          <span className="muted small">A new plan opens when the account refuses a purchase</span>
        </div>
        {initial ? (
          <ul className="reasons">
            {(initial.data.explanation as string[]).map((x) => (
              <li key={x}>
                <I n="check" />
                {x}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Run the first step: the controller derives the split, the keyring binds three mandates on chain.</p>
        )}
      </section>
    );
  }
  const id = opened.data.planId;
  const of = (t: string) => lastOf(events, t, (e) => e.data.planId === id);
  const options = of("plan.options");
  const chosen = of("plan.chosen");
  const pending = of("plan.pending_approval");
  const approved = of("plan.approved");
  const verified = of("plan.verified");
  const replaced = events.filter((e) => e.type === "mandate.replaced" && e.data.planId === id);
  const refusal = lastOf(events, "sourcing.refused", (e) => e.data.stage === "account");
  const status = verified
    ? { tone: "good" as const, text: "Verified on chain" }
    : replaced.length
      ? { tone: "good" as const, text: "Applied" }
      : approved
        ? { tone: "brand" as const, text: "Approved" }
        : pending
          ? { tone: "warn" as const, text: "Awaiting founder" }
          : chosen
            ? { tone: "plan" as const, text: "Chosen" }
            : { tone: "muted" as const, text: "Proposed" };
  return (
    <section className="card decision">
      <div className="card-head">
        <div>
          <p className="eyebrow">
            Plan <span className="mono">{id}</span>
          </p>
          <h2>The supplier raised its price</h2>
        </div>
        <Pill tone={status.tone} icon={verified ? "check" : undefined}>
          {status.text}
        </Pill>
      </div>
      {refusal && (
        <div className="trigger">
          <I n="alert" />
          <p>
            <b>
              {refusal.data.name} now asks {money(refusal.data.price)}, above cap S {money(refusal.data.cap)}.
            </b>{" "}
            The account refused the purchase on chain with <code>{refusal.data.code}</code>.
          </p>
          <Tx tx={refusal.data.tx} meta={meta} />
        </div>
      )}
      {options && (
        <table className="options">
          <colgroup>
            <col className="c-ok" />
            <col className="c-title" />
            <col className="c-num" />
            <col className="c-num" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>Option, enumerated in code</th>
              <th className="num">Moves</th>
              <th className="num">Margin/call</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {(options.data.options as any[]).map((o) => {
              const picked = chosen?.data.option === o.id;
              return (
                <tr key={o.id} className={picked ? "picked" : o.feasible ? "" : "out"}>
                  <td>{o.feasible ? <I n="check" className="good" /> : <I n="x" className="bad" />}</td>
                  <td>
                    <span className="opt">{o.id}</span> {o.title}
                    {picked && <span className="tag">picked</span>}
                  </td>
                  <td className="num">{cents(o.delta) ? money(o.delta, "") : "—"}</td>
                  <td className="num">{cents(o.marginPerCall) ? money(o.marginPerCall, "") : "—"}</td>
                  <td className="why">{o.reasons[0] ?? (o.needsApproval ? "feasible; needs the founder's approval" : "feasible")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {chosen && (
        <div className="planner">
          <div className="planner-head">
            <span className="claude">
              <I n="spark" />
            </span>
            <p>
              <b>
                Pick {chosen.data.option}: {chosen.data.title}
              </b>
              <span className="muted">{chosen.data.source === "planner" ? `ranked and explained by ${chosen.data.planner.model}` : "rule-based pick (planner unavailable)"}</span>
            </p>
          </div>
          <p className="explanation">{chosen.data.explanation}</p>
          <p className="fine">Code computed every number and checks the pick. The model ranks the options and explains them; it never sets an amount.</p>
        </div>
      )}
      {pending && (
        <div className={`approval ${approved ? "done" : ""}`}>
          <span className="lock">
            <I n={approved ? "check" : "lock"} />
          </span>
          <div className="approval-body">
            <p>
              <b>{approved ? `Approved by ${approved.data.approver}` : "Founder approval required"}</b>
              <span className="muted"> · {(pending.data.reasons as string[]).join(" · ")}</span>
            </p>
            <p className="mono muted small" title={pending.data.hash}>
              approval bound to sha256 {short(pending.data.hash, 16, 8)}
            </p>
          </div>
          {!approved && !meta?.replay && (
            <a className="button primary" href={pending.data.approveUrl} target="_blank" rel="noreferrer">
              Open approval page <I n="arrow" />
            </a>
          )}
        </div>
      )}
      {replaced.length > 0 && (
        <ol className="exec">
          {replaced.map((e) => (
            <li key={e.seq}>
              <span className={`avatar sm ${e.data.role}`}>{LETTER[e.data.role as Role]}</span>
              <span>
                <b>Replaced {LETTER[e.data.role as Role]}</b> cap {money(e.data.cap.from, "")} → {money(e.data.cap.to, "")} · budget {money(e.data.budget.from, "")} → {money(e.data.budget.to, "")} · spent carried {money(e.data.spentCarried, "")}
              </span>
              <Tx tx={e.data.tx} meta={meta} />
            </li>
          ))}
          {verified && (
            <li className="ok">
              <span className="avatar sm good">
                <I n="check" />
              </span>
              <span>mandate verify passes for every changed credential; I1–I5 hold after the change</span>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function Sales({ live, events }: { live?: Live; events: QmEvent[] }) {
  const cap = cents(live?.roles?.sourcing.cap);
  const sales = events.filter((e) => e.type === "sale.settled");
  const notCharged = events.filter((e) => e.type === "sale.not_charged").length;
  const revenue = sales.reduce((s, e) => s + cents(e.data.amount), 0n);
  const suppliers = live?.suppliers ?? [];
  const top = suppliers.reduce((m, s) => (cents(s.price) > m ? cents(s.price) : m), cap);
  const scale = top > 0n ? top + top / 3n + 1n : 6n;
  const sellPrice = sales.length ? cents(sales[sales.length - 1]!.data.amount) : 0n;
  const cost = cents(suppliers.find((s) => s.id === live?.supplier)?.price);
  return (
    <section className="card sales">
      <div className="card-head">
        <div>
          <p className="eyebrow">Revenue</p>
          <h2>Sales and suppliers</h2>
        </div>
        {live?.sourcingPaused && (
          <Pill tone="bad" icon="alert">
            sourcing paused
          </Pill>
        )}
      </div>
      <div className="kpis">
        <div>
          <p className="eyebrow">Sales settled</p>
          <p className="figure lg">{sales.length}</p>
        </div>
        <div>
          <p className="eyebrow">Revenue</p>
          <p className="figure lg">
            <Amt v={revenue} />
          </p>
        </div>
        <div>
          <p className="eyebrow" title="buyers answered 503 while sourcing was refused">Not charged</p>
          <p className="figure lg">{notCharged}</p>
        </div>
      </div>
      <p className="eyebrow gap">Upstream price per quote against cap S</p>
      <div className="feeds">
        {suppliers.length === 0 && <p className="empty">Feeds appear once the account is set up.</p>}
        {suppliers.map((s, i) => {
          const p = cents(s.price);
          const over = cap > 0n && p > cap;
          return (
            <div key={s.id} className="feed">
              <span className="feed-name">
                {s.name}
                {live?.supplier === s.id && <span className="tag">current</span>}
              </span>
              <span className="track">
                <span className={`fill ${over ? "over" : ""}`} style={{ width: `${pct(p, scale)}%` }} />
                {cap > 0n && <span className="cap" style={{ left: `${pct(cap, scale)}%` }} data-label={i === 0 ? `cap S ${money(cap, "")}` : undefined} />}
              </span>
              <span className={`feed-price ${over ? "bad" : "good"}`}>{money(s.price, "")}</span>
            </div>
          );
        })}
      </div>
      {cap > 0n && sales.length > 0 && (
        <div className="economics">
          <div>
            <span className="eyebrow">Sell</span>
            <b>{money(sellPrice, "")}</b>
          </div>
          <span className="op">−</span>
          <div>
            <span className="eyebrow">Upstream</span>
            <b>{money(cost, "")}</b>
          </div>
          <span className="op">=</span>
          <div>
            <span className="eyebrow">Margin per call</span>
            <b className={sellPrice - cost > 0n ? "good" : "bad"}>{money(sellPrice - cost, "")}</b>
          </div>
        </div>
      )}
    </section>
  );
}

function Disputes({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const resolved = lastOf(events, "dispute.resolved");
  const read = lastOf(events, "dispute.read");
  const filed = lastOf(events, "dispute.filed");
  return (
    <section className="card disputes">
      <div className="card-head">
        <div>
          <p className="eyebrow">Support</p>
          <h2>Disputes</h2>
        </div>
        {resolved && <Pill tone="good">{`${resolved.data.refundedTotal} USDZ refunded`}</Pill>}
      </div>
      {!filed && <p className="empty">A buyer's disputed batch is settled from the signed orders on chain and the delivery records.</p>}
      {read && <blockquote>{read.data.summary}</blockquote>}
      {filed && !resolved && (
        <p className="muted small">
          <span className="spin" /> Checking {filed.data.charges.length} charges against the chain…
        </p>
      )}
      {resolved && (
        <ul className="verdicts">
          {(resolved.data.decisions as any[]).map((d) => (
            <li key={d.settlementId} className={d.decision === "refunded" ? "ok" : "no"}>
              <Pill tone={d.decision === "refunded" ? "good" : "bad"}>{d.decision}</Pill>
              <span className="mono muted">{short(d.settlementId, 8, 4)}</span>
              <span className="why">{d.why}</span>
              <Tx tx={d.tx} meta={meta} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Treasury({ live, events, meta }: { live?: Live; events: QmEvent[]; meta?: Meta }) {
  const find = (t: string) => lastOf(events, t);
  const sweep = find("sweep.pulled");
  const settled = find("awx.deposit_settled");
  const quote = find("fx.quoted");
  const conv = find("fx.converted");
  const crash = find("drill.crashed");
  const recovered = find("drill.recovered");
  const statuses = events.filter((e) => e.type === "awx.transfer_status" && !e.data.ignored).map((e) => e.data.status as string);
  const late = events.filter((e) => e.type === "awx.transfer_status" && e.data.ignored).length;
  const paid = statuses.includes("PAID");
  const stages = [
    { n: 1, label: "Sweep under T", sub: "to the ramp address", done: !!sweep, value: sweep && <Amt v={sweep.data.amount} />, tx: sweep?.data.tx as string | undefined },
    { n: 2, label: "USD deposit", sub: "reference = sweep tx", done: !!settled, value: settled && <Amt v={settled.data.amount} unit="USD" /> },
    { n: 3, label: "MIN_1 FX quote", sub: "locked rate", done: !!quote, value: quote && <span className="amt">{quote.data.usdPerEur}<span className="unit">USD/EUR</span></span> },
    { n: 4, label: "Convert", sub: "USD to EUR", done: !!conv, value: conv && <Amt v={conv.data.buyEUR} unit="EUR" /> },
    { n: 5, label: "Pay the licence", sub: "EUR payout, request_id", done: paid, value: statuses.length > 0 && <span className="amt">{statuses[statuses.length - 1]}</span> },
  ];
  const held = (list: { currency: string; available_amount: string }[] | undefined, c: string) => decimalCents(list?.find((b) => b.currency === c)?.available_amount);
  return (
    <section className="card treasury">
      <div className="card-head">
        <div>
          <p className="eyebrow">Treasury agent · Airwallex</p>
          <h2>Earnings to Airwallex, licence fee paid</h2>
        </div>
        {live?.invoice && (
          <Pill tone={live.invoice.paid ? "good" : "muted"} icon={live.invoice.paid ? "check" : undefined}>
            {live.invoice.paid ? `${live.invoice.id} paid` : `${live.invoice.id} due ${live.invoice.dueAt.slice(0, 10)}`}
          </Pill>
        )}
      </div>
      <div className="kpis four">
        {["USD", "EUR"].map((c) => {
          const now = held(live?.awx, c);
          const moved = live?.awxOpening ? now - held(live.awxOpening, c) : undefined;
          return (
            <div key={c} title={`${c} balance ${money(now, "")}`}>
              <p className="eyebrow">{moved === undefined ? `${c} balance` : `${c} since setup`}</p>
              <p className="figure lg">
                <Amt v={moved ?? now} unit={c} signed={moved !== undefined} />
              </p>
            </div>
          );
        })}
        <div>
          <p className="eyebrow">Licence fee</p>
          <p className="figure lg">{live?.invoice ? <Amt v={live.invoice.amount} unit="EUR" /> : "—"}</p>
        </div>
        <div>
          <p className="eyebrow">Live rate</p>
          <p className="figure lg">{live?.usdPerEur ? <span className="amt">{Number(live.usdPerEur).toFixed(4)}<span className="unit">USD/EUR</span></span> : "—"}</p>
        </div>
      </div>
      <ol className="path">
        {stages.map((s) => (
          <li key={s.n} className={s.done ? "done" : ""}>
            <span className="node">{s.done ? <I n="check" /> : s.n}</span>
            <b>{s.label}</b>
            <span className="muted small">{s.sub}</span>
            <span className="value">{s.value || <span className="muted">—</span>}</span>
            {s.tx && <Tx tx={s.tx} meta={meta} />}
          </li>
        ))}
      </ol>
      {crash && (
        <div className="callout warn">
          <I n="bolt" />
          <p>
            <b>Fault drill:</b> the executor was killed right after <code>transfers/create</code>.{" "}
            {recovered ? (
              <>
                The retry sent the same <code>{recovered.data.requestId}</code>, got <code>duplicate_request_id</code> and loaded the same transfer. Nothing was paid twice.
              </>
            ) : (
              "Recovering…"
            )}
          </p>
        </div>
      )}
      {late > 0 && <p className="fine">{late === 1 ? "1 webhook arrived out of order and was" : `${late} webhooks arrived out of order and were`} ignored by the status guard.</p>}
    </section>
  );
}

function Books({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const r = lastOf(events, "recon.result");
  return (
    <section className="card books">
      <div className="card-head">
        <div>
          <p className="eyebrow">Reconciliation</p>
          <h2>Books</h2>
        </div>
        <div className="actions">
          {r && (
            <Pill tone={r.data.ok ? "good" : "bad"} icon={r.data.ok ? "check" : "x"}>
              {r.data.ok ? "reconciled to the cent" : "mismatch"}
            </Pill>
          )}
          {!meta?.replay && (
            <button className="ghost" onClick={() => runReconcile()}>
              Reconcile now
            </button>
          )}
        </div>
      </div>
      {!r && <p className="empty">Seven checks compare Metal, the ledger and Airwallex when the books close. Each check sets two independent systems against each other.</p>}
      {r && (
        <div className="checks">
          <div className="check head">
            <span />
            <span>Check</span>
            <span>One side</span>
            <span />
            <span>Other side</span>
          </div>
          {(r.data.checks as any[]).map((c) => (
            <div key={c.id} className={`check ${c.ok ? "ok" : "no"}`} title={c.detail}>
              <I n={c.ok ? "check" : "x"} />
              <span>
                <b>{c.id}.</b> {c.title}
              </span>
              <span className="mono">{c.left}</span>
              <span className="eq">{c.ok ? "=" : "≠"}</span>
              <span className="mono">{c.right}</span>
            </div>
          ))}
          <div className={`check ${r.data.chain.ok ? "ok" : "no"}`}>
            <I n={r.data.chain.ok ? "check" : "x"} />
            <span>Event log hash chain</span>
            <span className="mono">{r.data.chain.count} events</span>
            <span className="eq" />
            <span className="mono">head {short(r.data.chain.head, 10, 6)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

const ACTOR_CLASS: Record<string, string> = { sourcing: "s", support: "r", treasury: "t", keyring: "k", airwallex: "x", director: "d" };

function Timeline({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const lines = useMemo(
    () =>
      events
        .map((e) => ({ e, line: describe(e) }))
        .filter((x) => x.line)
        .slice(-160)
        .reverse(),
    [events],
  );
  return (
    <section className="card timeline">
      <div className="card-head">
        <div>
          <p className="eyebrow">Event log</p>
          <h2>Timeline</h2>
        </div>
        <span className="muted small">hash-chained · newest first</span>
      </div>
      {lines.length === 0 && <p className="empty">Every event lands here, chained to the one before it.</p>}
      <ul>
        {lines.map(({ e, line }) =>
          e.type === "story.step" && e.data.status === "started" ? (
            <li key={e.seq} className="divider">
              <span>{e.data.title}</span>
            </li>
          ) : (
            <li key={e.seq} className={`ev ${line!.tone}`}>
              <span className={`actor ${ACTOR_CLASS[e.actor] ?? ""}`}>{e.actor}</span>
              <span className="t mono">{time(e.at)}</span>
              <span className="text">
                {line!.text} <Tx tx={line!.tx} meta={meta} />
              </span>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

export function App() {
  const meta = useMeta();
  const live = useLive();
  const events = useEvents();
  return (
    <main>
      <Header meta={meta} live={live} events={events} />
      <div className="grid">
        <div className="col">
          <Story meta={meta} live={live} events={events} />
          <Account live={live} />
          <Mandates live={live} events={events} meta={meta} />
          <Decision events={events} meta={meta} />
          <div className="pair">
            <Sales live={live} events={events} />
            <Disputes events={events} meta={meta} />
          </div>
          <Treasury live={live} events={events} meta={meta} />
          <Books events={events} meta={meta} />
        </div>
        <aside className="col side">
          <Timeline events={events} meta={meta} />
        </aside>
      </div>
      {live?.error && <p className="callout bad">live state: {live.error}</p>}
    </main>
  );
}
