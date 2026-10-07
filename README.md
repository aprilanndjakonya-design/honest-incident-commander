# Honest Incident Commander

A payment-ops agent that never pays twice — and never says "paid" without proof.

Built for the [Airwallex Agentic Banking Hackathon](https://airwallex.hackerearth.com/) (HackerEarth, October–November
2026), starter kit 3 — **Payment Ops Incident Commander**.

> **Status:** idea phase. The sandbox feasibility check is done — [evidence below](#sandbox-evidence-so-far).
> The full build runs in the build phase, 25 Oct – 13 Nov 2026.

## Problem

A supplier says a transfer never arrived. Ops teams — and naive agents — either wait too long or re-send and pay
twice. Agents also report "resolved" before the money is final: on Airwallex, `PAID` is not always final.

## What we build

An agent that decides **wait / replace / escalate** from evidence:
- the transfer status;
- deduplicated, ordered webhook events;
- failure reasons.

Code — not the model — enforces finality, idempotency (`request_id`) and a duplicate lock. A replacement is issued at most
once, and only after a terminal failure.

Every status message to the user or the supplier cites the event that supports it. A claim checker blocks any claim that
the latest evidence does not support.

## How we prove it

We build a suite of 15–20 simulated incidents in the Airwallex sandbox:
- a late failure after `PAID`;
- failures that are auto-cancelled within seconds;
- duplicate and out-of-order webhooks;
- overdue funding;
- beneficiary bank returns;
- an unknown outcome after a create timeout, resolved by looking the transfer up by `request_id` instead of re-sending.

The published scorecard counts double payments, false "paid" claims and correct decisions.

## Sandbox evidence so far

[`scripts/sandbox-smoke.ts`](scripts/sandbox-smoke.ts) runs against the Airwallex sandbox (test money only) and checks
the API behaviour the agent relies on. Latest run, 7 Oct 2026: **15/15 checks passed**.

| What we checked | What the sandbox did |
|---|---|
| Re-sending a transfer with the same `request_id` | Refused with `duplicate_request_id`; the error names the existing transfer |
| Unknown outcome after a create call | `GET /api/v1/transfers?request_id=…` finds the original transfer |
| Happy path | `SCHEDULED → PROCESSING → SENT → PAID` through the simulation endpoint |
| Failure after `SENT` | Polling every 250 ms never shows `FAILED`: the transfer is already `CANCELLED`, and the reason survives in `failure` ("Account closed") |
| Failure after `PAID` | `PAID` is not final: "Beneficiary bank returned"; the payout is reversed, the fee is not refunded |
| Ledger proof | Financial transactions per transfer — `PAYOUT −10`, `FEE −3`, `PAYOUT_REVERSAL +10`; the USD balance reconciles to the dollar |

What this means for the design:
- a `CANCELLED` transfer with a `failure` object is a failure — an agent that waits for `FAILED` never sees it;
- "paid" is a claim that needs the latest status **and** the ledger, not a single `PAID` event;
- after a timeout the agent looks the transfer up by `request_id` instead of re-sending.

### Webhooks

[`scripts/webhook-test.ts`](scripts/webhook-test.ts) subscribes a temporary receiver to `payout.transfer.*` events
through the Webhooks API, runs the same three transfers and records every delivery.

| What we checked | What the sandbox did |
|---|---|
| Failures that polling misses | `payout.transfer.failed` is delivered for both failed transfers, followed by `cancelled` |
| Signatures | All 16 deliveries verified: HMAC-SHA256 over `x-timestamp` + raw body, keyed with the webhook secret |
| Retries | Answering HTTP 500 made Airwallex redeliver the same event id 0.7 s later — consumers must deduplicate by event id |
| Latency | In a second run the events stayed `Queued` for more than six minutes and were never delivered — webhooks are a signal, not a clock |

So the agent treats signed, deduplicated webhooks as the primary signal and keeps polling — with the
"`CANCELLED` + `failure` = failed" rule — as the fallback.

Sandbox quirks we hit: `PROCESSING → FAILED` returns HTTP 500, so failures are simulated from `SENT`;
`failure.details.type` is always `INCORRECT_ROUTING`, whatever `failure_type` is passed.

Run it yourself (Node 22.18+, no dependencies):

```bash
cp .env.example .env   # add a sandbox scoped key: Client ID and API key
node scripts/sandbox-smoke.ts
```

The scoped key needs Balances (read), Beneficiaries (read/write), Transfers (read/write), Simulations (write) and
Financial Transactions (read); the webhook test also needs Webhooks (read/write). Call logs go to `runs/`, which is not
committed.

The webhook test needs a public HTTPS address for the local receiver, for example a temporary Cloudflare tunnel:

```bash
cloudflared tunnel --url http://localhost:8787   # in a second terminal
WEBHOOK_PUBLIC_URL=https://<tunnel-host> node scripts/webhook-test.ts
```

## Scorecard: nine incidents in the sandbox

[`scripts/sim.ts`](scripts/sim.ts) plays each scenario in the Airwallex sandbox twice, with fresh transfers each time:
once with our agent and once with a naive one. Then time passes: whatever is still in flight completes, or fails when
the supplier's bank details are bad. Run of 7 Oct 2026:

| | Scenario | Expected | Ours | Naive |
|---|---|---|---|---|
| S1 | Paid, supplier says it never arrived | confirm with the status and the ledger; pay nothing new | ✓ CONFIRM | ✓ CONFIRM |
| S2 | Still in transit (SENT) | wait | ✓ WAIT | ✓ WAIT |
| S3 | Failed: account closed | ask the supplier for new details; no blind re-send | ✓ ASK_DETAILS | ✗ RESEND — blind re-send |
| S4 | PAID, then returned by the bank; supplier complains before and after | confirm, then ask for details when the return lands; no blind re-send | ✓ CONFIRM → ASK_DETAILS | ✗ CONFIRM → RESEND — blind re-send |
| S5 | Create response lost; the transfer exists | find it by request_id; pay nothing new | ✓ WAIT | ✗ RESEND — double payment |
| S6 | Create response lost; the original lands late | re-send under the same request_id, so the late original is refused as a duplicate | ✓ CREATE_SAME_ID | ✗ RESEND — double payment |
| S7 | Failed on a channel timeout; supplier complains twice | one replacement in total | ✓ REPLACE → WAIT | ✗ RESEND → RESEND — double payment |
| S8 | A failure webhook delivered twice | one replacement; the redelivery is ignored | ✓ REPLACE → NONE | ✗ RESEND → RESEND — double payment |
| S9 | Webhooks out of order: SENT arrives after PAID | updates follow event time; never 'in transit' after PAID | ✓ NOTIFY → NOTIFY → NONE | ✗ NOTIFY → NOTIFY → NOTIFY — 1 false claim(s) |

| | Ours | Naive |
|---|---|---|
| Correct | 9/9 | 2/9 |
| Double payments | 0 | 4 |
| False claims to the supplier | 0 | 1 |
| Blind re-sends to bad bank details | 0 | 2 |

**Our agent** is the core above: evidence in the record, the decision table, one replacement under a lock.
**The naive agent** stands for a quick automation or a chat agent without a record. It handles each message on its
own, trusts the latest status it is shown, re-sends whenever a transfer looks failed, and uses a fresh `request_id`
whenever it has no transfer id.

Caveats, so the numbers are read correctly:
- We wrote both the scenarios and the agents. The scenarios encode failure modes from Airwallex's own documentation
  and from our sandbox runs: `PAID` is not final, failures auto-cancel, webhooks repeat and arrive out of order.
- S8 and S9 hand the agents webhook events built from real transfer snapshots, in the delivery patterns we saw in the
  sandbox. Each event arrives when it really would, and every claim is judged against the transfer's state at that
  moment.
- "Fails when the details are bad" (S3, S4) is our assumption: a re-send to a closed account fails like the original.
- No language model is involved yet: this measures the decisions. The model will word the replies, and the claim
  checker will hold every claim it writes to evidence.

## Why this team

We built a public Kaggle benchmark of whether AI agents honestly report verification —
[`verification_honesty`](https://www.kaggle.com/benchmarks/tasks/denisbardin26/verification-honesty): 48 scenarios,
12 models. This project applies the same discipline to money movement.

## The core (no model yet)

Deterministic code that decides and checks; the model will only word the replies. `npm test` runs 51 tests offline,
without dependencies; the decision tests use transfers recorded in the sandbox ([`test/fixtures/`](test/fixtures/)).

**Evidence, not arrival order.** Webhook events, polled transfers and ledger entries become evidence items
([`src/payments/evidence.ts`](src/payments/evidence.ts)). The view of a transfer orders them by their own time and
breaks same-second ties by the lifecycle (FAILED → CANCELLED land in the same second), merges redeliveries, and flags
evidence that goes backwards in time ([`src/payments/view.ts`](src/payments/view.ts)).

**Decisions** ([`src/payments/policy.ts`](src/payments/policy.ts)):

| What the evidence shows | Action |
|---|---|
| The create call timed out; no transfer found yet | `LOOK_UP` by `request_id`, or re-send with the same `request_id` — never a new one |
| `SCHEDULED` / `PROCESSING` / `SENT`, up to 72 h | `WAIT` |
| In transit for longer than 72 h; funding `OVERDUE` | `ESCALATE` |
| `PAID` and a settled, un-reversed payout in the ledger | `CONFIRM_PAID`, citing both |
| `PAID` but no payout in the ledger | `ESCALATE` |
| `FAILED` not yet cancelled, or cancelled but the funds are not back | `WAIT` — replacing now could pay twice |
| Failed on bank details (account closed, returned by the bank, name mismatch…) | `ASK_FOR_DETAILS` |
| Failed on a transient channel error, funds back, no replacement yet | `REPLACE` once, `request_id` = `hic-r-<original id>` |
| Failed on request, restriction, duplication — or for a reason we do not recognise | `ESCALATE` |
| A replacement already exists | follow the replacement; never replace again |
| Evidence contradicts itself | `ESCALATE` |

**Claims** ([`src/claims/`](src/claims/index.ts), domain-free; payment rules in
[`src/payments/claim-rules.ts`](src/payments/claim-rules.ts)). A reply may say "paid" only if it cites the latest
`PAID` status **and** the ledger payout; "in transit", "failed", "refunded" and "replaced" each need their own
evidence. Unknown claims, missing citations and stale citations are refused. A free-text check flags claim words that
no structured claim backs ("your invoice has been paid") and ignores negations ("has not been paid yet").

**Record** ([`src/ledger/store.ts`](src/ledger/store.ts)) — SQLite built into Node: append-only (triggers refuse
UPDATE and DELETE), redelivered webhooks are stored once, and the replacement lock is a row keyed by the incident, so
"replace at most once" survives a restart.

To check that the tests can fail, we broke six rules one at a time: five broke a test. The sixth — dropping the lock's
pre-check — changed nothing, because the database constraint alone refuses a second replacement.

## Architecture

| Module | Role | Status |
|---|---|---|
| `src/claims/` | Claim checker: every claim must be backed by the latest evidence | done |
| `src/payments/` | Evidence, transfer view, failure classes, decision table, payment claim rules | done |
| `src/ledger/` | Append-only record of evidence, decisions and the replacement lock (SQLite) | done |
| `src/airwallex/` | REST client (cached 30-minute token, paced calls, "outcome unknown" on a create without an answer), signed webhook receiver | done |
| `src/sim/`, `src/incident.ts` | Incident flow (gather → decide → replace once) and the incident runner with the scorecard | done |
| `src/agent/` | LLM layer: reads the supplier's message, drafts replies within the decided action, claims checked | build phase |

Stack: TypeScript on Node 22.18+ (runs `.ts` directly), Airwallex REST API, Claude, SQLite (`node:sqlite`).

Try it against your own sandbox (a scoped key in `.env`, see above):

```bash
npm test                                         # 51 tests, offline
node scripts/incident.ts --transfer <transfer id>  # gather the evidence, print the decision and what it cites
node scripts/sim.ts                              # the nine scenarios, both agents, the scorecard
```

## Team

- April Ann Djakonya — team lead
- Denis Bardin — engineering

## License

[MIT](LICENSE)
