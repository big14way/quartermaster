import { useMemo } from "react";
import { runReconcile, runStep, useEvents, useLive, useMeta, type Live, type Meta, type QmEvent, type Role } from "./api";
import { describe } from "./describe";
import { LETTER, ROLE_JOB, ROLE_NAME, cents, money, pct, short, time } from "./format";

const ROLES: Role[] = ["sourcing", "support", "treasury"];

function Tx({ tx, meta, label }: { tx?: string; meta?: Meta; label?: string }) {
  if (!tx) return null;
  return (
    <a className="tx" href={`${meta?.explorer ?? ""}${tx}`} target="_blank" rel="noreferrer" title={tx}>
      {label ?? short(tx)}
    </a>
  );
}

function Header({ meta, live, events }: { meta?: Meta; live?: Live; events: QmEvent[] }) {
  const last = events[events.length - 1];
  return (
    <header className="top">
      <div className="brand">
        <span className="logo">Q</span>
        <div>
          <h1>Quartermaster</h1>
          <p>Three x402 agents, one Metal account, budgets that rebalance when supplier prices move</p>
        </div>
      </div>
      <div className="meta">
        {meta && <span className={`badge ${meta.mode === "live" ? "live" : "sim"}`}>{meta.replay ? "REPLAY" : meta.mode === "live" ? "LIVE · Metal testnet + Airwallex sandbox" : "SIMULATED · simnet + Airwallex simulator"}</span>}
        <span className="dim mono">block {live?.block ?? "—"}</span>
        <span className="dim mono" title={last?.hash}>
          {events.length} events · head {short(last?.hash, 6, 4)}
        </span>
      </div>
    </header>
  );
}

function Story({ meta, live, events }: { meta?: Meta; live?: Live; events: QmEvent[] }) {
  const status = new Map<string, string>();
  for (const e of events) if (e.type === "story.step") status.set(e.data.id, e.data.status);
  const running = live?.story?.running;
  const next = meta?.steps.find((s) => status.get(s.id) !== "done");
  const current = meta?.steps.find((s) => s.id === running) ?? next;
  return (
    <section className="card story">
      <div className="card-head">
        <h2>The story</h2>
        {!meta?.replay && (
          <div className="row">
            {next && (
              <button disabled={!!running} onClick={() => runStep(next.id)}>
                {running ? "Running…" : `Run: ${next.title}`}
              </button>
            )}
            <button className="ghost" disabled={!!running || !next} onClick={() => runStep("all")}>
              Run all
            </button>
          </div>
        )}
      </div>
      <ol className="steps">
        {meta?.steps.map((s, i) => {
          const st = status.get(s.id) ?? "pending";
          return (
            <li key={s.id} className={`step ${st}`}>
              <span className="n">{st === "done" ? "✓" : st === "failed" ? "!" : i + 1}</span>
              <span>{s.title}</span>
            </li>
          );
        })}
      </ol>
      {current && <p className="narration">{current.narration}</p>}
      {live?.story?.error && <p className="bad">{live.story.error}</p>}
    </section>
  );
}

function Allocation({ live }: { live?: Live }) {
  const total = cents(live?.totalAllocation ?? 2000);
  const roles = live?.roles;
  return (
    <section className="card wide">
      <div className="card-head">
        <h2>One account, three budgets</h2>
        <span className="dim">The account caps each budget. Quartermaster holds the sum.</span>
      </div>
      <div className="gauge" role="img" aria-label="Budgets as a share of the 20 USDZ allocation">
        {roles &&
          ROLES.map((r) => {
            const b = cents(roles[r].budget);
            const s = cents(roles[r].spent);
            return (
              <div key={r} className={`seg ${r}`} style={{ width: `${pct(b, total)}%` }} title={`${ROLE_NAME[r]}: ${money(s)} spent of ${money(b)}`}>
                <div className="spent" style={{ width: `${pct(s, b)}%` }} />
                <span>
                  {LETTER[r]} {money(b, "")}
                </span>
              </div>
            );
          })}
      </div>
      <div className="figures">
        <div>
          <span className="dim">Σ budgets</span>
          <b>{money(live?.sumBudgets)}</b>
          <span className="dim">of {money(total)}</span>
        </div>
        <div>
          <span className="dim">Σ remaining</span>
          <b>{money(live?.sumRemaining)}</b>
        </div>
        <div>
          <span className="dim">Account balance on chain</span>
          <b>{money(live?.balance)}</b>
        </div>
        <div>
          <span className="dim">Account</span>
          <b className="mono">{short(live?.account?.account, 8, 6)}</b>
        </div>
      </div>
      <div className="chips">
        {live?.invariants?.map((i) => (
          <span key={i.id} className={`chip ${i.ok ? "ok" : "no"}`} title={i.detail}>
            {i.ok ? "✓" : "✗"} {i.id} {i.title}
          </span>
        ))}
      </div>
    </section>
  );
}

function Mandates({ live, events, meta }: { live?: Live; events: QmEvent[]; meta?: Meta }) {
  const lastTx = (r: Role) => [...events].reverse().find((e) => (e.type === "mandate.bound" || e.type === "mandate.replaced") && e.data.role === r)?.data.tx as string | undefined;
  return (
    <div className="mandates">
      {ROLES.map((r) => {
        const m = live?.roles?.[r];
        const b = cents(m?.budget);
        const s = cents(m?.spent);
        return (
          <section key={r} className={`card mandate ${r}`}>
            <div className="card-head">
              <div className="row">
                <span className={`letter ${r}`}>{LETTER[r]}</span>
                <div>
                  <h3>{ROLE_NAME[r]} agent</h3>
                  <p className="dim small">{ROLE_JOB[r]}</p>
                </div>
              </div>
              <span className="dim small">v{m?.versions ?? 0}</span>
            </div>
            <dl>
              <dt>Cap per payment</dt>
              <dd>{money(m?.cap)}</dd>
              <dt>Budget</dt>
              <dd>{money(m?.budget)}</dd>
              <dt>Spent</dt>
              <dd>{money(m?.spent)}</dd>
            </dl>
            <div className="bar">
              <div style={{ width: `${pct(s, b)}%` }} />
            </div>
            <p className="small dim mono">
              mandate {short(m?.mandateId, 8, 4)} · <Tx tx={lastTx(r)} meta={meta} label="last bind" />
            </p>
            <p className="small dim">{m?.payees ? `${m.payees.length} listed payee${m.payees.length > 1 ? "s" : ""}` : "any payee"}</p>
          </section>
        );
      })}
    </div>
  );
}

function Suppliers({ live, events }: { live?: Live; events: QmEvent[] }) {
  const cap = cents(live?.roles?.sourcing.cap);
  const sales = events.filter((e) => e.type === "sale.settled");
  const notCharged = events.filter((e) => e.type === "sale.not_charged").length;
  const revenue = sales.reduce((s, e) => s + cents(e.data.amount), 0n);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Suppliers and sales</h2>
        {live?.sourcingPaused && <span className="chip no">sourcing paused</span>}
      </div>
      <table className="plain">
        <tbody>
          {live?.suppliers?.map((s) => {
            const p = cents(s.price);
            return (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b> {live.supplier === s.id && <span className="chip ok">current</span>}
                </td>
                <td className={p > cap ? "bad" : "good"}>{money(s.price)}</td>
                <td className="dim small">{p > cap ? `above cap ${money(cap)}` : `within cap ${money(cap)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="figures three">
        <div>
          <span className="dim">Sales settled</span>
          <b>{sales.length}</b>
        </div>
        <div>
          <span className="dim">Revenue</span>
          <b>{money(revenue)}</b>
        </div>
        <div>
          <span className="dim">Not charged (503)</span>
          <b>{notCharged}</b>
        </div>
      </div>
    </section>
  );
}

function PlanPanel({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const opened = [...events].reverse().find((e) => e.type === "plan.opened");
  const initial = events.find((e) => e.type === "plan.initial");
  if (!opened) {
    return (
      <section className="card wide">
        <div className="card-head">
          <h2>Plan</h2>
          <span className="dim">opens when a purchase is refused</span>
        </div>
        {initial ? (
          <ul className="explain">
            {(initial.data.explanation as string[]).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <p className="dim">Run the first step to split the account.</p>
        )}
      </section>
    );
  }
  const id = opened.data.planId;
  const of = (t: string) => [...events].reverse().find((e) => e.type === t && e.data.planId === id);
  const options = of("plan.options");
  const chosen = of("plan.chosen");
  const pending = of("plan.pending_approval");
  const approved = of("plan.approved");
  const verified = of("plan.verified");
  const replaced = events.filter((e) => e.type === "mandate.replaced" && e.data.planId === id);
  const refusal = [...events].reverse().find((e) => e.type === "sourcing.refused" && e.data.stage === "account");
  const status = verified ? "Verified" : replaced.length ? "Applied" : approved ? "Approved" : pending ? "Awaiting approval" : chosen ? "Chosen" : "Proposed";
  return (
    <section className="card wide plan">
      <div className="card-head">
        <h2>
          Plan <span className="mono dim">{id}</span>
        </h2>
        <span className={`chip ${verified ? "ok" : pending && !approved ? "warn" : ""}`}>{status}</span>
      </div>
      {refusal && (
        <p className="trigger">
          <b>Trigger:</b> {refusal.data.name} asks {money(refusal.data.price)}, above cap S {money(refusal.data.cap)}. The account refused the purchase with <code>{refusal.data.code}</code>{" "}
          <Tx tx={refusal.data.tx} meta={meta} />
        </p>
      )}
      {options && (
        <table className="options">
          <thead>
            <tr>
              <th />
              <th>Option</th>
              <th>Δ moved</th>
              <th>Margin / call</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {(options.data.options as any[]).map((o) => (
              <tr key={o.id} className={chosen?.data.option === o.id ? "picked" : o.feasible ? "" : "out"}>
                <td>{o.feasible ? <span className="good">✓</span> : <span className="bad">✗</span>}</td>
                <td>
                  <b>{o.id}.</b> {o.title}
                </td>
                <td>{cents(o.delta) ? money(o.delta) : "—"}</td>
                <td>{cents(o.marginPerCall) ? money(o.marginPerCall) : "—"}</td>
                <td className="small">{o.reasons[0] ?? (o.needsApproval ? "needs approval" : "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {chosen && (
        <div className="pick">
          <p>
            <b>
              Pick {chosen.data.option}: {chosen.data.title}
            </b>{" "}
            <span className="dim small">{chosen.data.source === "planner" ? `planner: ${chosen.data.planner.model}` : "rule-based (planner unavailable)"}</span>
          </p>
          <p className="explanation">{chosen.data.explanation}</p>
          {chosen.data.problems?.length > 0 && chosen.data.source !== "fallback" && <p className="small dim">Policy notes: {chosen.data.problems.join("; ")}</p>}
        </div>
      )}
      {pending && (
        <div className={`approval ${approved ? "done" : ""}`}>
          <div>
            <p>
              <b>{approved ? `Approved by ${approved.data.approver}` : "Founder approval required"}</b>
            </p>
            <p className="small">{(pending.data.reasons as string[]).join(" · ")}</p>
            <p className="small mono dim">sha256 {pending.data.hash}</p>
          </div>
          {!approved && !meta?.replay && (
            <a className="button" href={pending.data.approveUrl} target="_blank" rel="noreferrer">
              Open approval page
            </a>
          )}
        </div>
      )}
      {replaced.length > 0 && (
        <ol className="exec">
          {replaced.map((e) => (
            <li key={e.seq}>
              Replaced <b>{LETTER[e.data.role as Role]}</b>: cap {money(e.data.cap.from)} → {money(e.data.cap.to)}, budget {money(e.data.budget.from)} → {money(e.data.budget.to)}, spent carried {money(e.data.spentCarried)}{" "}
              <Tx tx={e.data.tx} meta={meta} />
            </li>
          ))}
          {verified && <li className="good">mandate verify passes for every changed credential; I1–I5 hold after the change</li>}
        </ol>
      )}
    </section>
  );
}

function Disputes({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const resolved = [...events].reverse().find((e) => e.type === "dispute.resolved");
  const read = [...events].reverse().find((e) => e.type === "dispute.read");
  return (
    <section className="card">
      <div className="card-head">
        <h2>Disputes</h2>
        {resolved && <span className="chip ok">{resolved.data.refundedTotal} USDZ refunded</span>}
      </div>
      {!resolved && <p className="dim">A buyer's disputed batch is settled from the signed orders and delivery records.</p>}
      {read && <p className="small">{read.data.summary}</p>}
      {resolved && (
        <ul className="decisions">
          {(resolved.data.decisions as any[]).map((d) => (
            <li key={d.settlementId} className={d.decision === "refunded" ? "good" : "bad"}>
              <b>{d.decision}</b> <span className="mono dim">{short(d.settlementId, 8, 4)}</span> {d.why} {d.tx && <Tx tx={d.tx} meta={meta} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Treasury({ live, events, meta }: { live?: Live; events: QmEvent[]; meta?: Meta }) {
  const find = (t: string) => [...events].reverse().find((e) => e.type === t);
  const sweep = find("sweep.pulled");
  const settled = find("awx.deposit_settled");
  const quote = find("fx.quoted");
  const conv = find("fx.converted");
  const crash = find("drill.crashed");
  const recovered = find("drill.recovered");
  const statuses = events.filter((e) => e.type === "awx.transfer_status" && !e.data.ignored).map((e) => e.data.status as string);
  const late = events.filter((e) => e.type === "awx.transfer_status" && e.data.ignored).length;
  const stages = [
    { label: "Sweep to ramp under T", done: !!sweep, detail: sweep && money(sweep.data.amount), tx: sweep?.data.tx },
    { label: "USD deposit, ref = tx hash", done: !!settled, detail: settled && `USD ${money(settled.data.amount, "")}` },
    { label: "MIN_1 quote", done: !!quote, detail: quote && `${quote.data.usdPerEur} USD/EUR` },
    { label: "Convert USD → EUR", done: !!conv, detail: conv && `EUR ${money(conv.data.buyEUR, "")}` },
    { label: "Transfer, request_id", done: statuses.length > 0, detail: statuses.join(" → ") },
  ];
  return (
    <section className="card">
      <div className="card-head">
        <h2>Airwallex</h2>
        <span className="dim small">{live?.usdPerEur ? `${Number(live.usdPerEur).toFixed(4)} USD/EUR` : ""}</span>
      </div>
      <div className="figures three">
        {["USD", "EUR"].map((c) => (
          <div key={c}>
            <span className="dim">{c} balance</span>
            <b>{live?.awx?.find((b) => b.currency === c)?.available_amount ?? "0.00"}</b>
          </div>
        ))}
        <div>
          <span className="dim">Licence fee</span>
          <b>{live?.invoice ? `EUR ${money(live.invoice.amount, "")}` : "—"}</b>
          <span className={live?.invoice?.paid ? "good small" : "dim small"}>{live?.invoice?.paid ? "paid" : live?.invoice ? `due ${live.invoice.dueAt.slice(0, 10)}` : ""}</span>
        </div>
      </div>
      <ol className="pipeline">
        {stages.map((s) => (
          <li key={s.label} className={s.done ? "done" : ""}>
            <span className="dot" />
            <span>{s.label}</span>
            <span className="dim small">{s.detail}</span>
            {s.tx && <Tx tx={s.tx} meta={meta} />}
          </li>
        ))}
      </ol>
      {crash && (
        <p className="small">
          <b>Fault drill:</b> executor killed after <code>transfers/create</code>. {recovered ? `Retry with ${recovered.data.requestId} got duplicate_request_id and loaded the same transfer. Nothing paid twice.` : "Recovering…"}
        </p>
      )}
      {late > 0 && (
        <p className="small dim">
          {late === 1 ? "1 webhook arrived out of order and was" : `${late} webhooks arrived out of order and were`} ignored by the status guard.
        </p>
      )}
    </section>
  );
}

function Recon({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const r = [...events].reverse().find((e) => e.type === "recon.result");
  return (
    <section className="card wide">
      <div className="card-head">
        <h2>Books</h2>
        <div className="row">
          {r && <span className={`chip ${r.data.ok ? "ok" : "no"}`}>{r.data.ok ? "reconciled to the cent" : "mismatch"}</span>}
          {!meta?.replay && (
            <button className="ghost" onClick={() => runReconcile()}>
              Reconcile now
            </button>
          )}
        </div>
      </div>
      {!r && <p className="dim">Seven checks across Metal, the ledger and Airwallex run when the books close.</p>}
      {r && (
        <table className="checks">
          <tbody>
            {(r.data.checks as any[]).map((c) => (
              <tr key={c.id} title={c.detail}>
                <td className={c.ok ? "good" : "bad"}>{c.ok ? "✓" : "✗"}</td>
                <td>
                  <b>{c.id}.</b> {c.title}
                </td>
                <td className="small mono">{c.left}</td>
                <td className="small mono">{c.right}</td>
              </tr>
            ))}
            <tr>
              <td className={r.data.chain.ok ? "good" : "bad"}>{r.data.chain.ok ? "✓" : "✗"}</td>
              <td>Event log hash chain</td>
              <td className="small mono">{r.data.chain.count} events</td>
              <td className="small mono">head {short(r.data.chain.head, 10, 6)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

function Timeline({ events, meta }: { events: QmEvent[]; meta?: Meta }) {
  const lines = useMemo(
    () =>
      events
        .map((e) => ({ e, line: describe(e) }))
        .filter((x) => x.line)
        .slice(-120)
        .reverse(),
    [events],
  );
  return (
    <section className="card timeline">
      <div className="card-head">
        <h2>Timeline</h2>
        <span className="dim small">hash-chained, newest first</span>
      </div>
      <ul>
        {lines.map(({ e, line }) => (
          <li key={e.seq} className={line!.tone}>
            <span className="mono dim">{time(e.at)}</span>
            <span className="actor">{e.actor}</span>
            <span className="text">{line!.text}</span>
            <Tx tx={line!.tx} meta={meta} />
          </li>
        ))}
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
        <div className="col main">
          <Story meta={meta} live={live} events={events} />
          <Allocation live={live} />
          <Mandates live={live} events={events} meta={meta} />
          <PlanPanel events={events} meta={meta} />
          <div className="pair">
            <Suppliers live={live} events={events} />
            <Disputes events={events} meta={meta} />
          </div>
          <div className="pair">
            <Treasury live={live} events={events} meta={meta} />
            <Recon events={events} meta={meta} />
          </div>
        </div>
        <div className="col side">
          <Timeline events={events} meta={meta} />
        </div>
      </div>
      {live?.error && <p className="bad small">live state: {live.error}</p>}
    </main>
  );
}
