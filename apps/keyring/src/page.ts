import { fromCents, type Mode } from "@qm/core";
import type { ApprovalRecord } from "@qm/policy";

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const usd = (c: unknown) => `${fromCents(BigInt(String(c)))}<span class="unit">USDZ</span>`;
const short = (h: unknown) => {
  const s = String(h ?? "");
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
};

const LETTER: Record<string, string> = { sourcing: "S", support: "R", treasury: "T" };

// The same tokens and type as the dashboard, so the founder sees one product.
const STYLE = `
@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url(/font/inter.woff2) format("woff2-variations")}
:root{--bg:#07090d;--surface:#0d1218;--surface-2:#121922;--surface-3:#18212c;--line:#1b2430;--line-2:#273242;--ink:#edf1f6;--ink-2:#a5afbd;--ink-3:#6b7686;--brand:#6d8dff;--brand-soft:rgba(109,141,255,.14);--s:#4f8fff;--r:#a57cff;--t:#23d3b4;--s-soft:rgba(79,143,255,.16);--r-soft:rgba(165,124,255,.16);--t-soft:rgba(35,211,180,.16);--good:#3dd68c;--good-soft:rgba(61,214,140,.12);--bad:#ff7a72;--bad-soft:rgba(255,122,114,.11);--warn:#f6b54a;--warn-soft:rgba(246,181,74,.12);--plan:#b39dff;--plan-soft:rgba(179,157,255,.13);color-scheme:dark}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#f3f5f8;--surface:#fff;--surface-2:#f7f8fb;--surface-3:#eef1f6;--line:#e3e7ee;--line-2:#d3d9e2;--ink:#121722;--ink-2:#4c5768;--ink-3:#7d8797;--brand:#3d63f5;--brand-soft:rgba(61,99,245,.1);--s:#2f6cf6;--r:#7c4dff;--t:#00917c;--s-soft:rgba(47,108,246,.12);--r-soft:rgba(124,77,255,.12);--t-soft:rgba(0,145,124,.12);--good:#0b8a55;--good-soft:rgba(11,138,85,.1);--bad:#c42b1f;--bad-soft:rgba(196,43,31,.08);--warn:#a86400;--warn-soft:rgba(168,100,0,.1);--plan:#6a4bd8;--plan-soft:rgba(106,75,216,.09);color-scheme:light}}
*{box-sizing:border-box}html{-webkit-font-smoothing:antialiased;background:var(--bg)}
body{margin:0;min-height:100vh;background:radial-gradient(1000px 520px at 50% -12%,rgba(109,141,255,.10),transparent 60%) no-repeat,var(--bg);color:var(--ink);font:14px/1.55 "Inter Variable",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"cv11","ss01","tnum"}
main{max-width:900px;margin:0 auto;padding:22px 24px 72px}
h1,h2,p{margin:0}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
.muted{color:var(--ink-3)}.unit{margin-left:.3em;font-size:.68em;font-weight:600;letter-spacing:.04em;color:var(--ink-3)}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:18px;margin-bottom:26px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px}.brand b{display:block;font-size:15px;letter-spacing:-.01em}.brand span{font-size:12.5px;color:var(--ink-3)}
.mark{width:36px;height:36px}.mark rect{fill:var(--surface-2);stroke:var(--line-2)}.mark path{fill:none;stroke-width:3.4;stroke-linecap:round}.mark .s{stroke:var(--s)}.mark .r{stroke:var(--r)}.mark .t{stroke:var(--t)}.mark .tail{stroke:var(--ink)}
.mode{display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 10px;border-radius:999px;border:1px solid var(--line-2);background:var(--surface);font-size:12.5px;color:var(--ink-2)}
.mode b{color:var(--ink);font-size:11.5px;letter-spacing:.04em;text-transform:uppercase}.mode i{width:8px;height:8px;border-radius:50%;background:var(--good)}.mode.sim i{background:var(--warn)}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}.eyebrow .mono{letter-spacing:0;text-transform:none;color:var(--ink-2)}
h1{margin:6px 0 16px;font-size:27px;font-weight:700;letter-spacing:-.02em;line-height:1.2}
h2{margin:30px 0 10px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.facts div+div{padding-left:14px;border-left:1px solid var(--line)}.facts b{display:block;margin-top:4px;font-size:17px;font-weight:650}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600;background:var(--surface-3);color:var(--ink-2)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}.pill.good{background:var(--good-soft);color:var(--good)}.pill.bad{background:var(--bad-soft);color:var(--bad)}
.card{margin-top:14px;padding:18px 20px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,.018),transparent 120px),var(--surface)}
.why{display:flex;gap:12px;background:var(--plan-soft);border-color:color-mix(in srgb,var(--plan) 22%,transparent)}
.spark{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--plan);color:var(--surface)}
.why p{font-size:14.5px;line-height:1.62}.why .pills{margin-top:10px}
svg.i{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{padding:11px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}tr:last-child td,tr:last-child th{border-bottom:0}
thead th{padding-top:0;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.ev th{width:42%;font-weight:500;color:var(--ink-3)}.ev td{font-weight:550}
.role{display:flex;align-items:center;gap:10px}.role b{display:block;text-transform:capitalize}
.av{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;font-weight:750}
.av.sourcing{background:var(--s-soft);color:var(--s)}.av.support{background:var(--r-soft);color:var(--r)}.av.treasury{background:var(--t-soft);color:var(--t)}
.n{white-space:nowrap;font-variant-numeric:tabular-nums}.arrow{color:var(--ink-3);padding:0 6px}.up{color:var(--warn);font-weight:650}.down{color:var(--good);font-weight:650}.same{color:var(--ink-2)}
.seq{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;background:var(--surface-3);font-size:11px;font-weight:700;color:var(--ink-2)}
.sign{border-color:color-mix(in srgb,var(--warn) 30%,var(--line))}
.sign-head{display:flex;gap:12px;align-items:flex-start}
.lock{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--warn-soft);color:var(--warn)}
.hash{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line);color:var(--ink-2);overflow-wrap:anywhere}
form{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px;margin-top:16px}
label{display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--ink-3)}
input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--ink);font:inherit;font-size:15px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--brand);box-shadow:0 0 0 4px var(--brand-soft)}
input[type=password]{letter-spacing:.3em}
.row{grid-column:1/-1;display:flex;gap:10px;margin-top:4px}
button{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line-2);border-radius:10px;padding:12px 18px;font:600 14px/1 inherit;font-family:inherit;color:var(--ink);background:var(--surface-2);cursor:pointer}
button.approve{background:var(--brand);border-color:transparent;color:#fff;box-shadow:0 10px 26px -12px var(--brand)}button.approve:hover{filter:brightness(1.08)}
.result{display:flex;gap:16px;align-items:flex-start}
.badge{flex:none;display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--good-soft);color:var(--good)}.badge svg{width:22px;height:22px;stroke-width:2.4}
.badge.bad{background:var(--bad-soft);color:var(--bad)}
.result h1{margin:0 0 6px;font-size:24px}.result .body{color:var(--ink-2)}.result ul{margin:12px 0 0;padding:0;list-style:none;display:grid;gap:8px}
.result li{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line)}
.result li b{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;font-size:12px}.result li b.sourcing{background:var(--s-soft);color:var(--s)}.result li b.support{background:var(--r-soft);color:var(--r)}.result li b.treasury{background:var(--t-soft);color:var(--t)}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
@media (max-width:720px){.facts{grid-template-columns:1fr 1fr}.facts div:nth-child(3){padding-left:0;border-left:0}form{grid-template-columns:1fr}}
`;

const MARK = `<svg class="mark" viewBox="0 0 36 36" aria-hidden="true"><rect x="0.5" y="0.5" width="35" height="35" rx="10"/><path class="s" d="M18.56 8.14A9 9 0 0 1 21.5 24.79"/><path class="r" d="M19.33 25.69A9 9 0 0 1 10.11 22.79"/><path class="t" d="M8.84 20.8A9 9 0 0 1 15.44 8.14"/><path class="tail" d="M21 21l6.2 6.2"/></svg>`;
const icon = (d: string) => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  lock: icon("M4.5 7.5h7v6h-7zM6 7.5V5.6a2 2 0 0 1 4 0v1.9"),
  spark: icon("M8 2v12M2.8 5l10.4 6M2.8 11l10.4-6"),
  check: icon("M3.5 8.5l3 3 6-7"),
  x: icon("M4.5 4.5l7 7M11.5 4.5l-7 7"),
};

function frame(title: string, mode: Mode | undefined, airwallex: "sim" | "live", body: string): string {
  const pill =
    mode === undefined
      ? ""
      : mode === "offline"
        ? `<span class="mode sim"><i></i><b>Simulated</b>Metal simnet · Airwallex simulator</span>`
        : `<span class="mode"><i></i><b>Live</b>Metal testnet · Airwallex ${airwallex === "sim" ? "simulated" : "sandbox"}</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>
<div class="bar"><div class="brand">${MARK}<div><b>Quartermaster keyring</b><span>Holds the owner key. Changes mandates only with the founder's PIN.</span></div></div>${pill}</div>
${body}
</main></body></html>`;
}

export function approvalPage(r: ApprovalRecord, hash: string, status: string, reasons: string[], token: string, mode: Mode, airwallex: "sim" | "live" = "live"): string {
  const dir = (a: unknown, b: unknown) => (BigInt(String(b)) > BigInt(String(a)) ? "up" : BigInt(String(b)) < BigInt(String(a)) ? "down" : "same");
  const changes = r.mandate_changes
    .map(
      (c, i) => `<tr>
        <td><span class="seq">${i + 1}</span></td>
        <td><div class="role"><span class="av ${esc(c.role)}">${LETTER[c.role] ?? ""}</span><div><b>${esc(c.role)}</b><span class="mono muted">${esc(short(c.mandate_id))}</span></div></div></td>
        <td class="n">${usd(c.old.cap)}<span class="arrow">→</span><span class="${dir(c.old.cap, c.new.cap)}">${usd(c.new.cap)}</span></td>
        <td class="n">${usd(c.old.budget)}<span class="arrow">→</span><span class="${dir(c.old.budget, c.new.budget)}">${usd(c.new.budget)}</span></td>
        <td class="mono muted">${c.new.payees ? c.new.payees.map((p) => esc(short(p))).join("<br>") : "any payee"}</td>
      </tr>`,
    )
    .join("");
  const e = r.evidence;
  const evidence: [string, string][] = [
    ["Offer from the counterparty", `${usd(e.offer_price_cents)} per call`],
    ["sha256 of the 402 offer", `<span class="mono">${esc(short(e.offer_header_sha256))}</span>`],
    ["Refusal on chain", e.refusal_code ? `${esc(e.refusal_code)}${e.refusal_tx ? ` <span class="mono muted">${esc(short(e.refusal_tx))}</span>` : ""}` : "none"],
    ["Account balance", usd(e.balance_cents)],
    ["Spent so far: S / R / T", `${fromCents(BigInt(String(e.spent_cents.sourcing)))} / ${fromCents(BigInt(String(e.spent_cents.support)))} / ${fromCents(BigInt(String(e.spent_cents.treasury)))}<span class="unit">USDZ</span>`],
    ["Snapshot block", `<span class="mono">${esc(e.balances_snapshot_block)}</span>`],
    ["FX rate bound", e.fx_usd_per_eur ? `${esc(e.fx_usd_per_eur)} USD per EUR` : `<span class="muted">not bound: treasury untouched</span>`],
  ];
  const pending = status === "PendingApproval";
  const body = `
<p class="eyebrow">Founder approval · plan <span class="mono">${esc(r.plan_id)}</span> · option ${esc(r.option)}</p>
<h1>${esc(r.title)}</h1>
<div class="facts">
  <div><span class="eyebrow">Moves</span><b>${usd(r.delta_usdz_cents)}</b></div>
  <div><span class="eyebrow">Counterparty</span><b>${esc(r.counterparty.name)}</b><span class="mono muted">${esc(short(r.counterparty.address))}</span></div>
  <div><span class="eyebrow">Invoice</span><b>${esc(r.invoice_ref)}</b></div>
  <div><span class="eyebrow">Status</span><b><span class="pill ${pending ? "warn" : status === "Rejected" ? "bad" : "good"}">${pending ? "Awaiting you" : esc(status)}</span></b></div>
</div>
<div class="card why"><span class="spark">${ICON.spark}</span><div><p>${esc(r.reason)}</p><div class="pills">${reasons.map((x) => `<span class="pill warn">needs approval: ${esc(x)}</span>`).join(" ")}</div></div></div>
<h2>Mandate changes, in the order they will be sent</h2>
<div class="card"><table><thead><tr><th></th><th>Mandate</th><th>Cap per payment</th><th>Budget</th><th>Payees</th></tr></thead><tbody>${changes}</tbody></table></div>
<h2>Evidence bound to this approval</h2>
<div class="card"><table class="ev">${evidence.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table></div>
<h2>Sign</h2>
<div class="card sign">
  <div class="sign-head"><span class="lock">${ICON.lock}</span><div><p>Before sending anything, the keyring rebuilds this record from live chain state and a fresh 402 probe. If the price, the balance, a spend or a mandate changed, it refuses and asks for a new approval. Expires ${esc(r.expires_at.replace("T", " ").slice(0, 16))} UTC.</p>
  <p class="hash mono">sha256 ${esc(hash)}</p></div></div>
  ${
    pending
      ? `<form method="post" action="/approve/${esc(r.plan_id)}">
    <input type="hidden" name="t" value="${esc(token)}">
    <div><label for="approver">Your name</label><input id="approver" name="approver" value="founder" autocomplete="name"></div>
    <div><label for="pin">Founder PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required></div>
    <div class="row"><button class="approve" name="decision" value="approve">${ICON.check} Approve and rewrite mandates</button><button class="reject" name="decision" value="reject" formnovalidate>Reject</button></div>
  </form>`
      : `<p style="margin-top:14px"><b>This plan is ${esc(status)}.</b></p>`
  }
</div>`;
  return frame("Approve plan", mode, airwallex, body);
}

export function resultPage(title: string, body: string, ok = false, mode?: Mode, airwallex: "sim" | "live" = "live"): string {
  return frame(
    title,
    mode,
    airwallex,
    `<div class="card result"><span class="badge ${ok ? "" : "bad"}">${ok ? ICON.check : ICON.x}</span><div><h1>${esc(title)}</h1><div class="body">${body}</div></div></div>
<p class="muted" style="margin-top:14px">You can close this tab and return to the dashboard.</p>`,
  );
}
