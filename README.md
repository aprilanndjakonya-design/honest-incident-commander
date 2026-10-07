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

Sandbox quirks we hit: `PROCESSING → FAILED` returns HTTP 500, so failures are simulated from `SENT`;
`failure.details.type` is always `INCORRECT_ROUTING`, whatever `failure_type` is passed.

Run it yourself (Node 22.18+, no dependencies):

```bash
cp .env.example .env   # add a sandbox scoped key: Client ID and API key
node scripts/sandbox-smoke.ts
```

The scoped key needs Balances (read), Beneficiaries (read/write), Transfers (read/write), Simulations (write) and
Financial Transactions (read). Call logs go to `runs/`, which is not committed.

## Why this team

We built a public Kaggle benchmark of whether AI agents honestly report verification —
[`verification_honesty`](https://www.kaggle.com/benchmarks/tasks/denisbardin26/verification-honesty): 48 scenarios,
12 models. This project applies the same discipline to money movement.

## Planned architecture

| Module | Role |
|---|---|
| `airwallex/` | Auth token cache (30-minute tokens), REST client with per-endpoint rate limits |
| `ledger/` | Append-only local store of transfers, events and locks (SQLite) |
| `policy/` | Deterministic state machine, decision table, duplicate lock |
| `agent/` | LLM layer: reads the supplier's message, picks an action allowed by the policy, drafts replies |
| `claims/` | Claim checker: every status claim must be backed by the latest evidence |
| `sim/` | Incident runner: creates transfers, drives sandbox status transitions, produces the scorecard |

Stack: TypeScript, Airwallex REST API and developer MCP, Claude, SQLite.

## Team

- April Ann Djakonya — team lead
- Denis Bardin — engineering

## License

[MIT](LICENSE)
