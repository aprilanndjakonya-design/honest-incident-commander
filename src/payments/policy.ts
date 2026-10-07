// Deterministic decisions for a "the money never arrived" incident. The model may word the replies; it never picks
// the action. Anything unexpected escalates to a human.

import { classify } from "./failures.ts";
import type { TransferView } from "./view.ts";

export type Action = "LOOK_UP" | "WAIT" | "CONFIRM_PAID" | "REPLACE" | "ASK_FOR_DETAILS" | "ESCALATE";

export interface Decision {
  action: Action;
  reason: string;
  cites: string[];
  replacementRequestId?: string;
}

export interface Incident {
  key: string; // the original transfer id, or its request_id while the id is unknown
  original: TransferView | null; // null: the create call timed out and the outcome is unknown
  replacement: { requestId: string; view: TransferView | null } | null; // from the replacement lock
  amount: number;
  now: string;
  maxTransitHours?: number;
}

// Deterministic, so a crash and a retry reuse it — and Airwallex refuses a second create with the same request_id.
export const replacementRequestId = (originalTransferId: string) => `hic-r-${originalTransferId}`;

const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

export function decide(inc: Incident): Decision {
  if (inc.replacement) return decideReplacement(inc);
  const v = inc.original;
  if (!v || v.status === null) {
    return {
      action: "LOOK_UP",
      reason: "outcome unknown: look the transfer up by request_id or re-send with the same request_id, never a new one",
      cites: [],
    };
  }
  if (v.conflict) return { action: "ESCALATE", reason: `contradictory evidence: ${v.conflict}`, cites: v.conflictEvidence };

  if (v.failed) {
    const cites = [v.failureEvidence!];
    if (v.status === "FAILED") {
      return { action: "WAIT", reason: "failed; waiting for Airwallex to cancel it and return the funds", cites };
    }
    if (v.ledger.reversed < v.ledger.paidOut) {
      return {
        action: "WAIT",
        reason: "failed, but the ledger shows no reversal yet: replacing now could pay twice",
        cites: [...cites, ...v.ledger.payoutEvidence],
      };
    }
    cites.push(...v.ledger.reversalEvidence);
    const { type, cls } = classify(v.failure);
    const what = `${type}${v.failure?.message ? ` ("${v.failure.message}")` : ""}${v.paidThenFailed ? ", returned after it was PAID" : ""}`;
    if (cls === "DETAILS") {
      return { action: "ASK_FOR_DETAILS", reason: `failed: ${what}; ask the supplier to confirm or correct the bank details`, cites };
    }
    if (cls === "RETRY") {
      return { action: "REPLACE", reason: `failed: ${what}; funds returned; one replacement`, cites, replacementRequestId: replacementRequestId(v.id) };
    }
    return { action: "ESCALATE", reason: `failed: ${what}; ${cls === "STOP" ? "not something to retry" : "unrecognised failure"}`, cites };
  }

  const cites = [v.statusEvidence!];
  switch (v.status) {
    case "CANCELLED":
      return { action: "ESCALATE", reason: "cancelled without a failure reason", cites };
    case "OVERDUE":
      return { action: "ESCALATE", reason: "funding overdue: the balance did not cover the transfer", cites };
    case "PAID":
      if (v.ledger.paidOut >= inc.amount && v.ledger.reversed === 0) {
        return {
          action: "CONFIRM_PAID",
          reason: `PAID at ${v.statusAt}; the ledger shows the payout settled; give the supplier the reference`,
          cites: [...cites, ...v.ledger.payoutEvidence],
        };
      }
      return { action: "ESCALATE", reason: "PAID, but the ledger does not show a settled payout of the full amount", cites };
  }

  const limit = inc.maxTransitHours ?? 72;
  const hours = hoursBetween(v.statusAt!, inc.now);
  if (hours > limit) {
    return { action: "ESCALATE", reason: `${v.status} for ${Math.round(hours)} h, longer than ${limit} h`, cites };
  }
  return { action: "WAIT", reason: `in transit: ${v.status} since ${v.statusAt}`, cites };
}

// Once a replacement exists, the incident follows the replacement — and never replaces again.
function decideReplacement(inc: Incident): Decision {
  const r = inc.replacement!;
  if (!r.view || r.view.status === null) {
    return { action: "LOOK_UP", reason: `replacement ${r.requestId}: outcome unknown, look it up by its request_id`, cites: [] };
  }
  const d = decide({ ...inc, key: r.view.id, original: r.view, replacement: null });
  if (d.action === "REPLACE") {
    return { action: "ESCALATE", reason: `the replacement failed too (${d.reason}); a human decides`, cites: d.cites };
  }
  return { ...d, reason: `replacement ${r.requestId}: ${d.reason}` };
}
