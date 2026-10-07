// What a payment-ops reply may claim, and what each claim must cite.

import type { Claim, Evidence, Rule, Verdict } from "../claims/index.ts";
import { viewOf, type TransferView } from "./view.ts";

const ok = (claim: Claim): Verdict => ({ claim, ok: true });
const no = (claim: Claim, reason: string): Verdict => ({ claim, ok: false, reason });

// The citation must be the latest status itself, not an older report of the same transfer.
const citesLatest = (cited: Evidence[], v: TransferView) =>
  cited.some((e) => e.kind === "status" && e.data.status === v.status && e.at === v.statusAt);

export const paymentRules: Record<string, Rule> = {
  // "Paid" needs the latest status to be PAID and a settled, un-reversed payout in the ledger — and cites both.
  paid(claim, cited, known) {
    const v = viewOf(claim.subject, known);
    if (v.status !== "PAID") return no(claim, `latest status is ${v.status ?? "unknown"}, not PAID`);
    if (!citesLatest(cited, v)) return no(claim, "does not cite the latest PAID status");
    if (v.ledger.paidOut <= 0 || v.ledger.reversed > 0) return no(claim, "the ledger does not show a settled, un-reversed payout");
    if (!cited.some((e) => v.ledger.payoutEvidence.includes(e.id))) return no(claim, "does not cite the ledger payout");
    return ok(claim);
  },

  in_transit(claim, cited, known) {
    const v = viewOf(claim.subject, known);
    if (!v.inFlight) return no(claim, `latest status is ${v.status ?? "unknown"}, not in transit`);
    if (!citesLatest(cited, v)) return no(claim, "does not cite the latest status");
    return ok(claim);
  },

  failed(claim, cited, known) {
    const v = viewOf(claim.subject, known);
    if (!v.failed) return no(claim, "no failure on record");
    if (!cited.some((e) => e.id === v.failureEvidence)) return no(claim, "does not cite the failure");
    return ok(claim);
  },

  // Our money came back: a settled PAYOUT_REVERSAL.
  refunded(claim, cited, known) {
    const v = viewOf(claim.subject, known);
    if (v.ledger.reversed <= 0) return no(claim, "the ledger shows no reversal");
    if (!cited.some((e) => v.ledger.reversalEvidence.includes(e.id))) return no(claim, "does not cite the reversal");
    return ok(claim);
  },

  replaced(claim, cited) {
    if (!cited.some((e) => e.kind === "replacement")) return no(claim, "does not cite a replacement");
    return ok(claim);
  },
};

// Words that make a claim in a free-text reply; see unbackedMentions in src/claims.
export const paymentLexicon: Record<string, RegExp> = {
  paid: /\b(?:paid|payment (?:is |was |has been )?(?:complete|completed|successful)|(?:money|funds) (?:has |have )?arrived)\b/i,
  in_transit: /\b(?:in transit|on (?:its|the) way|being processed)\b/i,
  failed: /\b(?:failed|was returned|bounced|was rejected)\b/i,
  refunded: /\b(?:refunded|reversed|returned to (?:our|your) (?:account|balance))\b/i,
  replaced: /\b(?:re-?sent|replacement transfer|sent (?:it )?again|new transfer)\b/i,
};
