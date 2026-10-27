# Quartermaster

**Three x402 agents, one Metal account, budgets that rebalance when supplier prices move.**

Quartermaster runs a pay-per-call market data API with three AI agents that share one Metal account. Each agent spends under its own on-chain mandate:

- **sourcing** buys upstream quotes;
- **support** refunds buyers;
- **treasury** moves earnings to Airwallex and pays a EUR licence fee.

The three budgets always add up to the money the business set aside.

When a supplier raises its price past the sourcing cap, the account refuses the purchase on chain. Quartermaster then:

1. re-plans the split;
2. gets a human approval bound to the exact mandate change;
3. rewrites the mandates on chain, shrinking the donor before growing the receiver.

At the end, the books reconcile Metal against Airwallex to the cent.

The model proposes and explains. Code and the chain decide.

Built for the Airwallex hackathon, **Kit 11: x402 Business Agents**, targeting the Metal Award.

```
pnpm install
pnpm demo --headless      # the whole story in the terminal, offline, no keys
pnpm demo                 # the same story on the dashboard at http://127.0.0.1:4000
```

---

## The story

The scenario follows the kit:

- The account holds **20 USDZ**, split across sourcing (10), support (4) and treasury (6).
- A query sells for **5 cents**. Its upstream data costs **2 cents**, under a **3 cent** cap.

| # | Step | What happens |
|---|---|---|
| 1 | **Accounts, mandates and the opening split** | The controller derives the split from first principles. Treasury gets the €5.00 licence fee plus the transfer fee at the live EUR/USD rate, plus a 2% buffer. Support gets more than the refund floor. Sourcing gets the rest. The keyring creates the account, funds it and binds three mandates. A customer business signs up with three buyer agents. The licence invoice is read and validated, including the IBAN checksum. |
| 2 | **Selling queries** | Buyer agents pay 5 cents a call over x402 with a **signed order**. For each sale, the sourcing agent buys a quote from Feed A under mandate S. Every sale is stored with its signed order, its tx hash and what was delivered. **Timeout drill:** one upstream settlement comes back `settlement_in_doubt`. The agent treats it as unconfirmed and looks it up in the facilitator's `/settlements` by nonce, books it once and never pays again blind. Feed A then serves stale data for a few calls. |
| 3 | **Supplier raises its price** | Feed A goes to 4 cents and Feed B to 5. The sourcing agent reads the price from the 402 on every request. It refuses before signing, and records the refusal on chain (`mandate_cap_exceeded`). Buyers get a 503 and are **not charged**. Code enumerates options A–E with exact numbers, and the planner ranks them. |
| 4 | **Approval and mandate rewrite** | The founder approves on the keyring's own page with a PIN that only the keyring holds. The keyring rebuilds the approval record from live chain state and a fresh 402 probe, and refuses on any drift. It then replaces **R (donor) before S (receiver)**. Both mandates pass `mandate verify`, I1–I5 hold, and sourcing resumes at the new price. |
| 5 | **Disputed batch** | A buyer disputes five charges by tx hash. Support verifies each signed order against the payment on chain and checks the delivery record. It refunds the four stale ones under R, one payment id per refund, and rejects the fresh one with evidence. |
| 6 | **Earnings to Airwallex, licence fee paid** | Treasury sweeps to the ramp address under T, which can pay nobody else. It simulates a USD deposit whose `reference` is the sweep's tx hash, checking for an existing one first. It then takes a `MIN_1` quote, converts USD→EUR, and creates the transfer with `request_id`. **Fault drill:** the executor is killed after `transfers/create`. The retry gets `duplicate_request_id` and loads the same transfer, so nothing is paid twice. |
| 7 | **Compromised agent drill** | A compromised support agent tries to send itself 10 USDZ. The account refuses on chain with `mandate_cap_exceeded`, and the refusal is recorded. |
| 8 | **Books close** | Seven reconciliation checks (below) run, plus a verification of the event log's hash chain. |

How the planner decides in step 3, with the numbers the demo produces:

| Option | | Why |
|---|---|---|
| A. Switch to Feed B | ✗ | Feed B asks 0.05, above cap S 0.03 and above the 0.04 margin limit. |
| **B. Raise cap S to 0.04, +0.50 from refunds** | **✓** | Highest margin that leaves the refund floor intact. Needs approval because the cap rises 33%. |
| C. Raise cap S to 0.04, +0.50 from treasury | ✗ | It would leave the licence fee 0.22 USDZ (4%) short at the live rate. |
| D. Pass the price through | ✗ | Cap S stays 0.03, so the account still refuses the purchase. |
| E. Pause and escalate | ✓ | Always possible; loses about 6.00 USDZ of sales an hour. |

---

## Architecture

```mermaid
flowchart LR
  subgraph Customer
    BUY[Buyer agents x3<br/>own Metal account,<br/>cap 0.10, payee = Quartermaster]
  end
  subgraph Quartermaster
    SELL[Seller<br/>GET /v1/snapshot 0.05<br/>signed order required]
    SRC[Sourcing agent<br/>mandate S<br/>payees: Feed A, Feed B]
    SUP[Support agent<br/>mandate R<br/>any payee, small cap]
    TRE[Treasury agent<br/>mandate T, payee: ramp<br/>Airwallex key, planner]
    CTRL[Controller<br/>event log, ledger,<br/>planning desk, reconciler]
    KEY[Keyring<br/>owner key, approval page,<br/>founder PIN]
    UI[Dashboard]
  end
  subgraph Metal
    ACC[Owner account<br/>USDZ + 3 mandates]
    FAC[Facilitator]
  end
  subgraph Airwallex
    GA[USD + EUR Global Accounts]
    FX[FX quotes and conversions]
    TR[Beneficiary + transfers]
  end
  FA[Feed A x402]
  FB[Feed B x402]
  BUY -- x402 + signed order --> SELL --> FAC
  SELL --> SRC -- x402 under S --> FA & FB
  SUP -- mandate pull --> BUY
  TRE -- mandate pull to ramp --> ACC
  TRE --> GA & FX & TR
  GA & TR -- signed webhooks --> CTRL
  CTRL -- proposal --> KEY
  KEY -- credential create + replace --> ACC
  CTRL --> UI
```

**Custody rules** (enforced by process boundaries, not by prompts):

- **Only the keyring holds the owner key.** It has no model in it, and it accepts two inputs:
  - the opening allocation, which it checks against the 20 USDZ total itself;
  - a proposal approved on its own page with the founder PIN.

  The controller and the planner can propose. They cannot approve.
- **Each agent is its own process with its own directory.** The directory holds only that agent's credential and P-256 mandate key. No agent can read another's key, and models never see a key.
- **The Airwallex API key lives only in the treasury agent.**
- **Mandates make the limits physical.** S can pay only the listed feeds, R refunds are capped per payment, and T can pay only the ramp. If an agent were fully compromised, it could still spend only inside its mandate (see step 7).

**Invariants**, checked before every plan, after every change and at the end:

| | Invariant |
|---|---|
| I1 | Σ budgets ≤ the 20 USDZ allocation, and Σ remaining ≤ balance − gas reserve. The account caps each budget; the sum is ours to enforce. |
| I2 | Treasury's remaining budget covers the licence fee at the live rate plus buffer. |
| I3 | Support's remaining budget stays above the refund floor (P95 refunds/h × runway × price). |
| I4 | Never buy above what we sell for: cap S ≤ sell price − minimum margin. |
| I5 | Each role has exactly one live mandate, and a replace references the current one. |

**Approval binding.** The approval is a canonical JSON record (sorted keys, SHA-256). It holds:

- the plan and option;
- every mandate change, old → new;
- the amount moved and the counterparty;
- the invoice reference;
- evidence: the 402 offer hash and price, the refusal tx, the balance, the spend per role, and the FX rate when treasury is touched;
- the planner's explanation and an expiry.

The approval page shows exactly these fields. Before sending anything, the keyring rebuilds the record from live state. If the price moved, the balance or a spend changed, a mandate was replaced or the approval expired, it refuses and names what drifted. The controller then re-plans.

**Idempotency.**

- **Airwallex `request_id`s** are `qm:cv:{invoice}:{attempt}` and `qm:tr:{invoice}:{attempt}`, at most 47 characters. They are retried only for conversions and transfers, and always with the same id:
  - `duplicate_request_id` loads the existing object;
  - `409 request_pending` backs off.
- **The deposit's idempotency key is the sweep tx hash.** The treasury agent scans `GET /deposits` for it before creating one.
- **Metal payouts use one `--payment-id` per refund or sweep**, so a re-run pays at most once.
- **Seller deliveries are keyed on `settlement.first`.**
- **Every ledger entry is unique by `(source, external_id)`.**

**Books.**

- **Double-entry ledger** in integer cents (bigint) on SQLite. USDZ is converted to 18-decimal base units only at the Metal boundary; Airwallex amounts are parsed losslessly.
- **Webhooks** are verified with HMAC over `x-timestamp + raw body`, deduplicated by event id, acknowledged before processing, and applied through a monotonic transfer-status guard. FAILED overrides PAID; late webhooks are ignored and shown on the dashboard.
- **A poller** folds in the same Airwallex state, so lost webhooks never stall the books.

**Reconciliation checks:**

1. Facilitator `/settlements` to our account = sales booked.
2. Every mandate, current and replaced, passes `mandate verify`, and its on-chain spend = ledger spend.
3. On-chain account balance = ledger.
4. Σ ramp sweeps (USDZ) = Σ settled Airwallex deposits whose reference is a sweep tx (USD, 1:1).
5. USD deposits − conversion sells = USD balance = ledger.
6. EUR bought = licence fee + transfer fee; the transfer is PAID; licence payable = 0.
7. I1–I5 hold.

On top of these, the event log's hash chain must verify.

**Event log and replay.** Every event goes into `runs/<id>.jsonl`. Each line carries the previous line's hash, so editing or dropping any line breaks the chain. Model inputs are hashed and their outputs are recorded, so replays never call the API.

---

## Claude

- **Planner** (`claude-haiku-5-5` by default): the treasury agent sends it the option table, with every number already computed. It returns a pick, a ranking and a plain-language explanation for the approver, as structured output. The policy engine accepts the pick only if it is an enumerated, feasible option and its numbers match exactly. Otherwise a deterministic rule picks the highest-margin feasible option.
- **Extraction** (`claude-haiku-5-5` by default): reads the supplier invoice into strict fields and reads dispute claims. Code validates the invoice (IBAN mod-97, currency, amount, date) and decides every refund.
- **Models** are set by `QM_PLANNER_MODEL` and `QM_ASSIST_MODEL`. Server-side refusal fallbacks are sent only to models that have them (Opus, Sonnet, Fable); on Haiku a refusal falls to the rule-based path.
- **Without `ANTHROPIC_API_KEY`**, rule-based paths run instead, and the dashboard says which source made each decision.

---

## Running it

Requirements: Node 22.13+ (for `node:sqlite`) and pnpm 10.

### Offline (no keys)

```bash
pnpm install
pnpm demo                 # dashboard at http://127.0.0.1:4000; the terminal prints the founder PIN
pnpm demo --headless      # the whole story, approvals included, exits 0 if the books reconcile
pnpm replay runs/sample-offline.jsonl            # verify and re-narrate a recorded run
pnpm replay runs/sample-offline.jsonl --serve    # the dashboard on that recording
```

Offline mode runs two local stand-ins. Both are labelled **SIMULATED** in the UI.

- **Metal simnet** (`packages/sim/src/simnet`):
  - USDZ balances, and owner accounts that hold mandates;
  - P-256 mandate keys and issuer-signed credentials;
  - the account-side checks with Metal's refusal codes;
  - replace (spend carries over) and recorded refusals;
  - a facilitator with `/verify`, `/settle` (`settlement.first`) and `/settlements`;
  - a tiny explorer.
- **Airwallex simulator** (`packages/sim/src/awx`):
  - the same REST paths and shapes Quartermaster calls;
  - `request_id` duplicates;
  - MIN_1 quotes and transfer transitions;
  - a kept fee on a bounce;
  - signed webhooks delivered out of order.

Both sides use the same interfaces as the live adapters. The Airwallex client is the same code in both modes; only the base URL changes.

### Live (Metal testnet + Airwallex sandbox)

1. **Metal.**
   - Create an RPC endpoint at <https://console-testnet.metalntwx.com> (chain 63825).
   - `metal-agent` 0.3.3 is installed as a workspace dependency.
2. **Airwallex.**
   - Sign up for a sandbox account and create an API key.
   - Webhooks are optional, because the poller covers them. To receive them, point a public tunnel at `POST /webhooks/airwallex` and set the secret.
3. **Configure.** `cp .env.example .env`, then fill in:
   - `METAL_RPC_URL` and `QM_RAMP_ADDRESS` (a Metal address you control);
   - `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY`;
   - optionally `ANTHROPIC_API_KEY`.
4. **Check the CLI output parsers.** `pnpm live:check` runs a throwaway account through `account create`, `credential create`, `bind`, `status`, `pay --mandate` against Metal's public demo seller, and `verify`. It prints the raw output beside what was parsed.
5. **Run.** `pnpm demo --live`. The faucet grants about 100 USDZ per address once a minute; Quartermaster still holds the budgets to the 20 USDZ allocation in code.

In live mode:

- The seller and the feeds use `@x402/express` with `registerMetalScheme`, plus `requireSignedOffer` on the seller route.
- Agents pay with `metal-agent pay --mandate`.
- Refunds and sweeps use `metal-agent mandate pull` with a `--payment-id`.
- The keyring uses `mandate credential create --mandate-key-file` and `mandate replace`.
- Support verifies signed orders with `verifyMandatePayment`.

---

## Repository

```
apps/
  agents/       sourcing, support, treasury: one process per agent (src/main.ts <role>)
  keyring/      owner key, opening allocation, approval page, mandate replace
  controller/   event log, ledger + webhooks, planning desk, reconciler, story director, API
  seller/       Quartermaster's paid route; stores signed orders and deliveries
  feeds/        Feed A and Feed B, upstream x402 sellers with price and quality controls
  buyers/       the customer: its own account and three buyer agents
  dashboard/    Vite + React UI served by the controller
  sim/          hosts the Metal simnet and the Airwallex simulator offline
packages/
  core/         bigint cents, canonical JSON + SHA-256, request ids, hash-chained event log, kit config
  ledger/       double-entry ledger and document store on node:sqlite
  airwallex/    REST client: token cache, rate limits, lossless JSON, idempotent creates, FX orientation,
                transfer status guard, webhook HMAC
  metal/        OwnerRail / AgentRail interfaces, metal-agent CLI adapter, x402 offers, live paywall
  sim/          Metal simnet and Airwallex simulator behind the same interfaces
  policy/       invariants I1–I5, options A–E, fallback rule, approval records and drift checks
  planner/      Claude planner and extraction, recorded for replay
  runtime/      mode switch, file layout, HTTP helpers, event reporting
scripts/        demo supervisor, replay, live check
runs/           event logs; sample-offline.jsonl is a recorded run
```

Tests: run `pnpm test` and `pnpm test:e2e`. CI runs both on every push.

- `pnpm test` runs 47 unit tests: money, hashing, the ledger, the Airwallex client and the simulators, the policy math and approval drift, webhook dedupe, the late-status guard and FAILED-after-PAID reversal.
- `pnpm test:e2e` runs the whole offline story, which must reconcile.

## Licence

MIT
