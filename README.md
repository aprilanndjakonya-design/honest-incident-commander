# Honest Incident Commander

A payment-ops agent that never pays twice — and never says "paid" without proof.

Built for the [Airwallex Agentic Banking Hackathon](https://airwallex.hackerearth.com/) (HackerEarth, October–November
2026), starter kit 3 — **Payment Ops Incident Commander**.

> **Status:** idea phase. The build phase runs 25 Oct – 13 Nov 2026; code lands here during the build phase.

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
