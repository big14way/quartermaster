import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import {
  KIT,
  QmError,
  ROLES,
  canonicalHash,
  env,
  fromCents,
  logger,
  mode,
  optionalEnv,
  sumCents,
  toCents,
  url,
  usdz,
  varDir,
  type Address,
  type Payee,
  type Role,
} from "@qm/core";
import { probeOffer } from "@qm/metal";
import {
  approvalHash,
  approvalLinkToken,
  executionOrder,
  recheckApproval,
  signApproval,
  verifyApproval,
  type Approval,
  type ApprovalRecord,
  type MandateChange,
} from "@qm/policy";
import { agentFiles, callInternal, explorerTx, jsonApp, metalRail, publicFiles, readAccount, report, requireInternal, route, serve, type AccountInfo } from "@qm/runtime";
import { generateP256, addressOfKey, publicOf, writeJson, writeKeyFile } from "@qm/sim";
import { approvalPage, resultPage } from "./page";

// The keyring is the only process that holds the owner key. It has no model in it. It
// accepts two inputs: the opening allocation (checked against the 20 USDZ total), and a
// proposal that a human approved on this process's own page, whose hash it rebuilds from
// live state before sending anything.

const log = logger("keyring");
const dir = varDir("keyring");
mkdirSync(dir, { recursive: true });
mkdirSync(publicFiles.dir, { recursive: true });
const ownerKeyFile = join(dir, "owner-key.json");
const stateFile = join(dir, "state.json");
const rail = metalRail({ ownerKeyFile, home: dir });
const SECRET = env("QM_APPROVAL_SECRET", "dev-approval-secret");
const PIN = env("QM_FOUNDER_PIN", "2468");

interface FeedRef {
  id: string;
  name: string;
  payTo: Address;
  url: string;
}

type PlanStatus = "PendingApproval" | "Approved" | "Rejected" | "Expired" | "DonorReplaced" | "Applied" | "Compensating" | "Escalated" | "Refused";

interface Proposal {
  record: ApprovalRecord;
  hash: string;
  status: PlanStatus;
  needsApproval: boolean;
  approvalReasons: string[];
  approval?: Approval;
  steps: { role: Role; tx?: string; explorer?: string; mandateId?: string; error?: string }[];
  drift?: string[];
}

interface KeyringState {
  feeds: FeedRef[];
  payees: Partial<Record<Role, Payee[] | null>>;
  proposals: Record<string, Proposal>;
}

const state: KeyringState = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { feeds: [], payees: {}, proposals: {} };
const save = () => writeJson(stateFile, state, 0o600);

function readJsonFile<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

/** Install a credential the keyring just wrote into the agent's directory and the public copy. */
function publish(role: Role, credentialPath: string) {
  const files = agentFiles(role);
  if (credentialPath !== files.credential) renameSync(credentialPath, files.credential);
  const history = existsSync(publicFiles.history(role)) ? readJsonFile<string[]>(publicFiles.history(role)) : [];
  const archived = varDir("public", `${role}.${history.length + 1}.credential.json`);
  copyFileSync(files.credential, archived);
  copyFileSync(files.credential, publicFiles.credential(role));
  writeJson(publicFiles.history(role), [...history, archived]);
}

function payeesFor(role: Role, addresses: Address[] | null): Payee[] | null {
  if (!addresses) return null;
  const known = state.payees[role] ?? [];
  return addresses.map((a) => known.find((p) => p.address.toLowerCase() === a.toLowerCase()) ?? { address: a });
}

function rampAddress(): Address {
  if (mode() === "live") return env("QM_RAMP_ADDRESS") as Address;
  const f = join(dir, "ramp-key.json");
  if (!existsSync(f)) writeKeyFile(f, "ramp", generateP256());
  return addressOfKey(publicOf(readJsonFile<{ jwk: never }>(f).jwk), "ramp:");
}

// ---- bootstrap: the opening allocation ------------------------------------------------

async function bootstrap(body: { allocation: Record<Role, { cap: string; budget: string }>; feeds: FeedRef[]; planId: string; explanation: string[] }) {
  const existing = readAccount();
  if (existing) return { account: existing, existing: true };

  const budgets = ROLES.map((r) => toCents(body.allocation[r].budget));
  const total = sumCents(budgets);
  if (total > KIT.totalAllocation) throw new QmError("allocation_exceeds_total", `Σ budgets ${usdz(total)} exceeds ${usdz(KIT.totalAllocation)}`);

  const { account, owner, tx } = await rail.createAccount();
  const ramp = rampAddress();
  const info: AccountInfo = { account, owner, ramp, createdTx: tx };
  report("keyring", "account.created", { account, owner, ramp, tx, explorer: tx ? explorerTx(tx) : undefined });

  const funded = await rail.fund(account, KIT.totalAllocation);
  const balance = await rail.balanceOf(account);
  report("keyring", "account.funded", { account, tx: funded.tx, amount: balance, explorer: funded.tx ? explorerTx(funded.tx) : undefined });

  state.feeds = body.feeds;
  state.payees = {
    sourcing: body.feeds.map((f) => ({ address: f.payTo, name: f.name })),
    support: null,
    treasury: [{ address: ramp, name: "Airwallex ramp" }],
  };
  const descriptions: Record<Role, string> = {
    sourcing: "Sourcing agent: buys upstream market data",
    support: "Support agent: refunds buyers",
    treasury: "Treasury agent: moves earnings to Airwallex",
  };

  for (const role of ROLES) {
    const files = agentFiles(role);
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    const terms = {
      cap: toCents(body.allocation[role].cap),
      budget: toCents(body.allocation[role].budget),
      payees: state.payees[role] ?? null,
      description: descriptions[role],
    };
    const cred = await rail.createCredential({ principal: account, terms, out: files.credential });
    // Keep the mandate key where the agent looks for it, whatever name the CLI chose.
    if (cred.mandateKeyPath !== files.mandateKey) renameSync(cred.mandateKeyPath, files.mandateKey);
    const bound = await rail.bind(cred.credentialPath);
    if (!existsSync(publicFiles.issuer)) copyFileSync(cred.issuerPublicPath, publicFiles.issuer);
    publish(role, cred.credentialPath);
    report("keyring", "mandate.bound", {
      role,
      mandateId: cred.mandateId,
      cap: terms.cap,
      budget: terms.budget,
      payees: terms.payees,
      tx: bound.tx,
      explorer: explorerTx(bound.tx),
      planId: body.planId,
    });
  }
  writeJson(publicFiles.account, info);
  save();
  report("keyring", "plan.applied", { planId: body.planId, option: "initial", explanation: body.explanation });
  return { account: info, existing: false };
}

// ---- proposals and approvals --------------------------------------------------------

/** Rebuild the approval record from what the chain and the supplier say right now. */
async function liveRecord(approved: ApprovalRecord): Promise<ApprovalRecord> {
  const live = JSON.parse(JSON.stringify(approved)) as ApprovalRecord;
  const account = readAccount()!;
  const statuses = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await rail.status(publicFiles.credential(r))] as const)));
  for (const mc of live.mandate_changes) {
    const s = statuses[mc.role]!;
    mc.mandate_id = s.mandateId;
    mc.old = { cap: s.cap, budget: s.budget, payees: s.payees };
  }
  live.evidence.spent_cents = { sourcing: statuses.sourcing!.spent, support: statuses.support!.spent, treasury: statuses.treasury!.spent };
  live.evidence.balance_cents = await rail.balanceOf(account.account);
  const feed = state.feeds.find((f) => f.payTo.toLowerCase() === (approved.counterparty.address ?? "").toLowerCase());
  if (feed) {
    const probe = await probeOffer(`${feed.url}/quote?symbol=EURUSD`);
    live.evidence.offer_price_cents = probe.offer?.price ?? 0n;
    live.evidence.offer_header_sha256 = probe.offer ? canonicalHash(probe.offer.requirement) : "";
    live.counterparty = { address: probe.offer?.payTo ?? null, name: feed.name };
  }
  if (approved.evidence.fx_usd_per_eur !== null) {
    const r = await callInternal<{ usdPerEur: string }>("treasury", "/awx/rate");
    live.evidence.fx_usd_per_eur = Number(r.usdPerEur).toFixed(6);
  }
  return live;
}

async function execute(planId: string) {
  const p = state.proposals[planId]!;
  const recheck = recheckApproval(p.record, await liveRecord(p.record));
  if (!recheck.ok) {
    p.status = recheck.drift.includes("approval expired") ? "Expired" : "Refused";
    p.drift = recheck.drift;
    save();
    report("keyring", "plan.refused", { planId, drift: recheck.drift, liveHash: recheck.liveHash, approvedHash: p.hash });
    return p;
  }
  const account = readAccount()!;
  const changes: MandateChange[] = p.record.mandate_changes.map((c) => ({
    role: c.role,
    mandateId: c.mandate_id,
    old: { cap: BigInt(c.old.cap), budget: BigInt(c.old.budget), payees: c.old.payees },
    new: { cap: BigInt(c.new.cap), budget: BigInt(c.new.budget), payees: c.new.payees },
  }));

  // I1 as the last line: after the change the budgets still fit the allocation.
  const after = await Promise.all(ROLES.map(async (r) => changes.find((c) => c.role === r)?.new.budget ?? (await rail.status(publicFiles.credential(r))).budget));
  if (sumCents(after) > KIT.totalAllocation) {
    p.status = "Refused";
    p.drift = [`Σ budgets after the change ${usdz(sumCents(after))} exceeds ${usdz(KIT.totalAllocation)}`];
    save();
    report("keyring", "plan.refused", { planId, drift: p.drift });
    return p;
  }

  p.status = "Approved";
  p.steps = [];
  for (const [i, c] of executionOrder(changes).entries()) {
    const files = agentFiles(c.role);
    const current = await rail.status(publicFiles.credential(c.role));
    if (c.new.budget <= current.spent) {
      p.status = i === 0 ? "Refused" : "Escalated";
      p.steps.push({ role: c.role, error: `new budget ${usdz(c.new.budget)} is not above the ${usdz(current.spent)} already spent` });
      break;
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const next = join(files.dir, "credential.next.json");
        const cred = await rail.createCredential({
          principal: account.account,
          terms: { cap: c.new.cap, budget: c.new.budget, payees: payeesFor(c.role, c.new.payees) },
          out: next,
          mandateKeyFile: files.mandateKey,
        });
        const rep = await rail.replace(cred.credentialPath, publicFiles.credential(c.role));
        publish(c.role, cred.credentialPath);
        p.steps.push({ role: c.role, tx: rep.tx, explorer: explorerTx(rep.tx), mandateId: cred.mandateId });
        p.status = i === 0 && changes.length > 1 ? "DonorReplaced" : "Applied";
        report("keyring", "mandate.replaced", {
          planId,
          role: c.role,
          from: current.mandateId,
          to: cred.mandateId,
          cap: { from: c.old.cap, to: c.new.cap },
          budget: { from: c.old.budget, to: c.new.budget },
          spentCarried: rep.spent,
          tx: rep.tx,
          explorer: explorerTx(rep.tx),
        });
        break;
      } catch (err) {
        const msg = (err as Error).message;
        if (i > 0 && attempt === 1) {
          p.status = "Compensating";
          report("keyring", "plan.compensating", { planId, role: c.role, error: msg });
          continue;
        }
        p.status = i === 0 ? "Refused" : "Escalated";
        p.steps.push({ role: c.role, error: msg });
        report("keyring", i === 0 ? "plan.refused" : "plan.escalated", { planId, role: c.role, error: msg });
        break;
      }
    }
    if (p.status === "Refused" || p.status === "Escalated") break;
  }
  if (p.status === "DonorReplaced") p.status = "Applied";
  save();
  if (p.status === "Applied") report("keyring", "plan.applied", { planId, option: p.record.option, steps: p.steps });
  return p;
}

function pinOk(given: string) {
  const a = Buffer.from(given.padEnd(32));
  const b = Buffer.from(PIN.padEnd(32));
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = jsonApp();
app.use("/approve", express.urlencoded({ extended: false }));

app.post("/bootstrap", requireInternal, route((req) => bootstrap(req.body)));

app.post("/proposals", requireInternal, route(async (req) => {
  const { record, needsApproval, approvalReasons } = req.body as { record: ApprovalRecord; needsApproval: boolean; approvalReasons: string[] };
  const hash = approvalHash(record);
  const existing = state.proposals[record.plan_id];
  if (existing) return { planId: record.plan_id, hash: existing.hash, status: existing.status };
  state.proposals[record.plan_id] = { record, hash, status: "PendingApproval", needsApproval, approvalReasons, steps: [] };
  save();
  const approveUrl = `${url("keyring")}/approve/${record.plan_id}?t=${approvalLinkToken(SECRET, record.plan_id, hash)}`;
  if (!needsApproval) {
    const p = state.proposals[record.plan_id]!;
    p.approval = signApproval(SECRET, hash, "policy:autonomy");
    report("keyring", "plan.approved", { planId: record.plan_id, approver: "policy:autonomy", hash });
    const out = await execute(record.plan_id);
    return { planId: record.plan_id, hash, status: out.status };
  }
  report("keyring", "plan.pending_approval", { planId: record.plan_id, hash, approveUrl, reasons: approvalReasons });
  log.info(`approval needed for ${record.plan_id}: ${approveUrl}  (founder PIN required)`);
  return { planId: record.plan_id, hash, status: "PendingApproval", approveUrl };
}));

app.get("/proposals/:id", route((req) => {
  const p = state.proposals[String(req.params.id)];
  if (!p) throw new QmError("not_found", "no such plan", { status: 404 });
  return { planId: p.record.plan_id, status: p.status, hash: p.hash, steps: p.steps, drift: p.drift, approver: p.approval?.approver };
}));

app.get("/approve/:id", (req, res) => {
  const p = state.proposals[String(req.params.id)];
  const t = String(req.query.t ?? "");
  if (!p || t !== approvalLinkToken(SECRET, p.record.plan_id, p.hash)) {
    res.status(403).type("html").send(resultPage("Link not valid", "This approval link is not valid for any open plan."));
    return;
  }
  res.type("html").send(approvalPage(p.record, p.hash, p.status, p.approvalReasons, t, mode()));
});

app.post("/approve/:id", async (req, res, next) => {
  try {
    const p = state.proposals[String(req.params.id)];
    const t = String(req.body.t ?? "");
    const json = req.is("application/json");
    const reply = (status: number, title: string, body: string, data: unknown) =>
      json ? res.status(status).json(data) : res.status(status).type("html").send(resultPage(title, body));
    if (!p || t !== approvalLinkToken(SECRET, p.record.plan_id, p.hash)) return reply(403, "Link not valid", "This approval link is not valid.", { code: "bad_link" });
    if (p.status !== "PendingApproval") return reply(409, "Already decided", `This plan is ${p.status}.`, { code: "decided", status: p.status });
    if (!pinOk(String(req.body.pin ?? ""))) return reply(403, "Wrong PIN", "The founder PIN did not match. Nothing was changed.", { code: "bad_pin" });
    const approver = String(req.body.approver || "founder").slice(0, 60);
    if (req.body.decision === "reject") {
      p.status = "Rejected";
      save();
      report("keyring", "plan.rejected", { planId: p.record.plan_id, approver });
      return reply(200, "Rejected", "The plan was rejected. Sourcing stays paused until a new plan is approved.", { status: p.status });
    }
    p.approval = signApproval(SECRET, p.hash, approver);
    if (!verifyApproval(SECRET, p.approval) || p.approval.hash !== approvalHash(p.record)) throw new Error("approval did not verify");
    report("keyring", "plan.approved", { planId: p.record.plan_id, approver, hash: p.hash, approvedAt: p.approval.approvedAt });
    const out = await execute(p.record.plan_id);
    const steps = out.steps.map((s) => `${s.role}: ${s.error ?? s.tx}`).join("<br>");
    return reply(200, out.status === "Applied" ? "Approved and applied" : `Plan ${out.status}`, out.status === "Applied" ? `Mandates rewritten on chain.<br>${steps}` : (out.drift ?? []).join("<br>") || steps, {
      status: out.status,
      steps: out.steps,
      drift: out.drift,
    });
  } catch (err) {
    next(err);
  }
});

serve(app, "keyring", "keyring");
log.info(`approver PIN is held here only; controller and planner cannot approve. Allocation total ${fromCents(KIT.totalAllocation)} USDZ`);
if (optionalEnv("QM_FOUNDER_PIN") === undefined) log.warn("QM_FOUNDER_PIN not set; using the development PIN");
