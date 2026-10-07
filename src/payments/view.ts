// Folds all evidence about one transfer into what we actually know about it.
//
// Arrival order means nothing (webhooks arrive late, twice, or out of order), so statuses are ordered by their own
// time. Airwallex timestamps have one-second resolution and FAILED → CANCELLED (or PAID → FAILED) often lands in the
// same second, so the lifecycle order breaks ties.

import type { Evidence } from "../claims/index.ts";
import type { Failure, TransferStatus } from "./types.ts";

const RANK: Record<TransferStatus, number> = {
  SCHEDULED: 0, OVERDUE: 1, PROCESSING: 2, SENT: 3, PAID: 4, FAILED: 5, CANCELLATION_REQUESTED: 5, CANCELLED: 6,
};

const IN_FLIGHT: TransferStatus[] = ["SCHEDULED", "PROCESSING", "SENT", "CANCELLATION_REQUESTED"];

export interface TransferView {
  id: string;
  status: TransferStatus | null;
  statusAt: string | null;
  statusEvidence: string | null;
  inFlight: boolean;
  // FAILED, or CANCELLED with a failure object (the sandbox cancels a failed transfer within a second)
  failed: boolean;
  failure: Failure | null;
  failureEvidence: string | null;
  paidEvidence: string | null;
  paidThenFailed: boolean;
  // Evidence that goes backwards in the lifecycle, e.g. PROCESSING reported after PAID
  conflict: string | null;
  conflictEvidence: string[];
  ledger: { paidOut: number; reversed: number; fees: number; payoutEvidence: string[]; reversalEvidence: string[] };
  history: { status: TransferStatus; at: string; evidence: string }[];
}

const statusOf = (e: Evidence) => e.data.status as TransferStatus;

export function byLifecycle(a: Evidence, b: Evidence): number {
  return a.at.localeCompare(b.at) || RANK[statusOf(a)] - RANK[statusOf(b)] || a.id.localeCompare(b.id);
}

export function viewOf(id: string, evidence: Evidence[]): TransferView {
  const mine = evidence.filter((e) => e.subject === id);
  const statuses = mine.filter((e) => e.kind === "status").sort(byLifecycle);

  // The same status at the same second from a webhook and from a poll is one fact.
  const history: TransferView["history"] = [];
  for (const e of statuses) {
    const prev = history.at(-1);
    if (prev && prev.status === statusOf(e) && prev.at === e.at) continue;
    history.push({ status: statusOf(e), at: e.at, evidence: e.id });
  }

  let conflict: string | null = null;
  const conflictEvidence: string[] = [];
  for (let i = 1; i < history.length; i++) {
    const [a, b] = [history[i - 1], history[i]];
    if (RANK[b.status] < RANK[a.status]) {
      conflict = `${b.status} at ${b.at} after ${a.status} at ${a.at}`;
      conflictEvidence.push(a.evidence, b.evidence);
      break;
    }
  }

  const last = statuses.at(-1) ?? null;
  const failing = statuses.filter((e) => statusOf(e) === "FAILED" || (statusOf(e) === "CANCELLED" && !!e.data.failure));
  const lastFailing = failing.at(-1) ?? null;
  const withReason = failing.filter((e) => !!e.data.failure).at(-1) ?? null;
  const lastPaid = statuses.filter((e) => statusOf(e) === "PAID").at(-1) ?? null;

  const settled = mine.filter((e) => e.kind === "ledger" && e.data.status === "SETTLED");
  const ofType = (t: string) => settled.filter((e) => e.data.type === t);
  const total = (t: string) => ofType(t).reduce((s, e) => s + Number(e.data.amount), 0);

  return {
    id,
    status: last ? statusOf(last) : null,
    statusAt: last?.at ?? null,
    statusEvidence: last?.id ?? null,
    inFlight: !!last && IN_FLIGHT.includes(statusOf(last)),
    failed: !!lastFailing,
    failure: (withReason?.data.failure as Failure | undefined) ?? null,
    failureEvidence: (withReason ?? lastFailing)?.id ?? null,
    paidEvidence: lastPaid?.id ?? null,
    paidThenFailed: !!lastPaid && !!lastFailing && byLifecycle(lastPaid, lastFailing) < 0,
    conflict,
    conflictEvidence,
    ledger: {
      paidOut: -total("PAYOUT"),
      reversed: total("PAYOUT_REVERSAL"),
      fees: -total("FEE"),
      payoutEvidence: ofType("PAYOUT").map((e) => e.id),
      reversalEvidence: ofType("PAYOUT_REVERSAL").map((e) => e.id),
    },
    history,
  };
}
