import { fromCents, type Mode } from "@qm/core";
import type { ApprovalRecord } from "@qm/policy";

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const usd = (c: unknown) => `${fromCents(BigInt(String(c)))} USDZ`;
const short = (h: unknown) => {
  const s = String(h ?? "");
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
};

const STYLE = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#14171c;--muted:#5b6472;--line:#e3e6eb;--accent:#0f62fe;--good:#0a7d4f;--warn:#a15c00;--bad:#b42318;--chip:#eef1f5}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d1014;--panel:#151a21;--ink:#e8ebef;--muted:#97a1ae;--line:#26303b;--accent:#5b9bff;--good:#3ecf8e;--warn:#f5a524;--bad:#ff6b6b;--chip:#1d242e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:28px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;overflow-wrap:anywhere}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:2px 10px;font-size:12px;margin:0 6px 6px 0}
.reason{border-left:3px solid var(--accent);padding:4px 0 4px 12px;margin:8px 0}
.arrow{color:var(--muted);padding:0 6px}.up{color:var(--warn);font-weight:600}.down{color:var(--good);font-weight:600}
form{display:grid;gap:12px;margin-top:8px}label{font-size:13px;color:var(--muted)}input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
.row{display:flex;gap:10px;flex-wrap:wrap}button{border:0;border-radius:8px;padding:11px 18px;font:600 15px/1 inherit;cursor:pointer}
.approve{background:var(--accent);color:#fff}.reject{background:var(--chip);color:var(--ink)}
.banner{border-radius:8px;padding:8px 12px;background:var(--chip);font-size:13px;margin-bottom:16px}
`;

export function approvalPage(r: ApprovalRecord, hash: string, status: string, reasons: string[], token: string, mode: Mode): string {
  const changes = r.mandate_changes
    .map((c) => {
      const capDir = BigInt(String(c.new.cap)) > BigInt(String(c.old.cap)) ? "up" : BigInt(String(c.new.cap)) < BigInt(String(c.old.cap)) ? "down" : "";
      const budDir = BigInt(String(c.new.budget)) > BigInt(String(c.old.budget)) ? "up" : BigInt(String(c.new.budget)) < BigInt(String(c.old.budget)) ? "down" : "";
      return `<tr>
        <td><b>${esc(c.role)}</b><div class="mono muted">${esc(short(c.mandate_id))}</div></td>
        <td>${usd(c.old.cap)}<span class="arrow">→</span><span class="${capDir}">${usd(c.new.cap)}</span></td>
        <td>${usd(c.old.budget)}<span class="arrow">→</span><span class="${budDir}">${usd(c.new.budget)}</span></td>
        <td class="mono">${c.new.payees ? c.new.payees.map((p) => esc(short(p))).join("<br>") : "any payee"}</td>
      </tr>`;
    })
    .join("");
  const e = r.evidence;
  const evidence: [string, string][] = [
    ["Offer from counterparty", `${usd(e.offer_price_cents)} per call`],
    ["Offer hash (sha256 of the 402 offer)", `<span class="mono">${esc(short(e.offer_header_sha256))}</span>`],
    ["Refusal", e.refusal_code ? `${esc(e.refusal_code)}${e.refusal_tx ? ` <span class="mono">${esc(short(e.refusal_tx))}</span>` : ""}` : "none"],
    ["Account balance", usd(e.balance_cents)],
    ["Spent so far (S / R / T)", `${usd(e.spent_cents.sourcing)} / ${usd(e.spent_cents.support)} / ${usd(e.spent_cents.treasury)}`],
    ["Snapshot block", String(e.balances_snapshot_block)],
    ["FX bound", e.fx_usd_per_eur ? `${esc(e.fx_usd_per_eur)} USD per EUR` : "not bound (treasury untouched)"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve plan</title><style>${STYLE}</style></head><body><main>
${mode === "offline" ? `<div class="banner">SIMULATED: Metal simnet and Airwallex simulator</div>` : ""}
<p class="muted mono">Plan ${esc(r.plan_id)} · option ${esc(r.option)} · ${esc(status)}</p>
<h1>${esc(r.title)}</h1>
<p class="muted">Moves <b>${usd(r.delta_usdz_cents)}</b> (${esc(r.currency)}) · counterparty <b>${esc(r.counterparty.name)}</b> <span class="mono">${esc(short(r.counterparty.address))}</span> · invoice ${esc(r.invoice_ref)}</p>
<div class="card">
  <div class="reason">${esc(r.reason)}</div>
  <div>${reasons.map((x) => `<span class="chip">needs approval: ${esc(x)}</span>`).join("")}</div>
</div>
<h2>Mandate changes, in the order they will be sent</h2>
<div class="card"><table><tr><th>Mandate</th><th>Cap</th><th>Budget</th><th>Payees</th></tr>${changes}</table></div>
<h2>Evidence bound to this approval</h2>
<div class="card"><table>${evidence.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table></div>
<h2>Approve</h2>
<div class="card">
  <p class="muted">Expires ${esc(r.expires_at)}. Before sending anything the keyring rebuilds this record from live state. If the price, balance, spend or a mandate changed, it refuses and asks for a new approval.</p>
  <p class="mono muted">sha256 ${esc(hash)}</p>
  ${
    status === "PendingApproval"
      ? `<form method="post" action="/approve/${esc(r.plan_id)}">
    <input type="hidden" name="t" value="${esc(token)}">
    <div><label for="approver">Your name</label><input id="approver" name="approver" value="founder" autocomplete="name"></div>
    <div><label for="pin">Founder PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required></div>
    <div class="row"><button class="approve" name="decision" value="approve">Approve and rewrite mandates</button><button class="reject" name="decision" value="reject" formnovalidate>Reject</button></div>
  </form>`
      : `<p><b>This plan is ${esc(status)}.</b></p>`
  }
</div>
</main></body></html>`;
}

export function resultPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${esc(title)}</h1><div class="card"><p>${body}</p></div><p class="muted">You can close this tab and return to the dashboard.</p></main></body></html>`;
}
