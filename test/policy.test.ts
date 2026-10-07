import assert from "node:assert/strict";
import { test } from "node:test";
import { fromLedger, fromSnapshot } from "../src/payments/evidence.ts";
import { decide, replacementRequestId, type Incident } from "../src/payments/policy.ts";
import { viewOf } from "../src/payments/view.ts";
import { event, evidenceOf, fx, hoursAfter, ids } from "./helpers.ts";

const NOW = "2026-10-07T12:00:00.000Z";
const inc = (over: Partial<Incident>): Incident => ({ key: "k", original: null, replacement: null, amount: 10, now: NOW, ...over });

test("unknown outcome after a create timeout: look up, never re-create with a new request_id", () => {
  const d = decide(inc({ original: null }));
  assert.equal(d.action, "LOOK_UP");
  assert.match(d.reason, /same request_id/);
});

test("in transit: wait, then escalate after the limit", () => {
  const v = viewOf(ids.A, fx.transfers.A.slice(0, 1).map(fromSnapshot)); // PROCESSING
  assert.equal(decide(inc({ original: v, now: hoursAfter(v.statusAt!, 2) })).action, "WAIT");
  const late = decide(inc({ original: v, now: hoursAfter(v.statusAt!, 80) }));
  assert.equal(late.action, "ESCALATE");
  assert.match(late.reason, /longer than 72 h/);
});

test("A: PAID with a settled payout → confirm, citing the status and the ledger", () => {
  const v = viewOf(ids.A, evidenceOf("A"));
  const d = decide(inc({ original: v }));
  assert.equal(d.action, "CONFIRM_PAID");
  assert.ok(d.cites.includes(v.statusEvidence!));
  assert.ok(d.cites.some((c) => c.startsWith("ftx:")));
});

test("PAID without a ledger payout → escalate, never confirm", () => {
  assert.equal(decide(inc({ original: viewOf(ids.A, evidenceOf("A", { ledger: false })) })).action, "ESCALATE");
});

test("B: account closed → ask the supplier for details instead of re-sending", () => {
  const d = decide(inc({ original: viewOf(ids.B, evidenceOf("B")) }));
  assert.equal(d.action, "ASK_FOR_DETAILS");
  assert.match(d.reason, /ACCOUNT_CLOSED/);
  assert.ok(d.cites.some((c) => c.startsWith("ftx:")), "cites the reversal");
});

test("C: returned after PAID → ask for details, and say it was returned after PAID", () => {
  const d = decide(inc({ original: viewOf(ids.C, evidenceOf("C")) }));
  assert.equal(d.action, "ASK_FOR_DETAILS");
  assert.match(d.reason, /returned after it was PAID/);
});

test("FAILED, not yet cancelled → wait", () => {
  const failed = event("e-f", fx.transfers.B[1], "FAILED", "2026-10-07T11:34:57+0000", { code: "90701", message: "Account closed" });
  const v = viewOf(ids.B, [...fx.transfers.B.slice(0, 2).map(fromSnapshot), failed]);
  assert.equal(decide(inc({ original: v })).action, "WAIT");
});

test("failed and cancelled, but no reversal yet → wait: replacing now could pay twice", () => {
  const noReversal = evidenceOf("B").filter((e) => e.data.type !== "PAYOUT_REVERSAL");
  const d = decide(inc({ original: viewOf(ids.B, noReversal) }));
  assert.equal(d.action, "WAIT");
  assert.match(d.reason, /no reversal/);
});

// The sandbox cannot be told which failure code to return, so these cases are built by hand.
function failedWith(failure: { code: string; message: string }) {
  return viewOf(ids.B, [
    ...fx.transfers.B.slice(0, 2).map(fromSnapshot),
    event(`e-${failure.code}`, fx.transfers.B[1], "CANCELLED", "2026-10-07T11:34:57+0000", failure),
    ...fx.ledger.filter((l) => l.source_id === ids.B).map(fromLedger),
  ]);
}
const timedOut = () => failedWith({ code: "00000", message: "Channel timeout" });

test("a transient failure with the funds back → one replacement with a deterministic request_id", () => {
  const d = decide(inc({ original: timedOut() }));
  assert.equal(d.action, "REPLACE");
  assert.equal(d.replacementRequestId, replacementRequestId(ids.B));
  assert.equal(decide(inc({ original: timedOut() })).replacementRequestId, d.replacementRequestId);
});

test("an unrecognised failure → escalate", () => {
  const d = decide(inc({ original: failedWith({ code: "99902", message: "Other" }) }));
  assert.equal(d.action, "ESCALATE");
  assert.match(d.reason, /OTHER.*unrecognised/);
});

test("once a replacement exists the incident follows it and never replaces again", () => {
  const rid = replacementRequestId(ids.B);
  const again = decide(inc({ original: viewOf(ids.B, evidenceOf("B")), replacement: { requestId: rid, view: timedOut() } }));
  assert.equal(again.action, "ESCALATE");
  assert.match(again.reason, /replacement failed too/);

  const inTransit = viewOf(ids.A, fx.transfers.A.slice(0, 2).map(fromSnapshot));
  const d = decide(inc({ replacement: { requestId: rid, view: inTransit }, now: hoursAfter(inTransit.statusAt!, 1) }));
  assert.equal(d.action, "WAIT");
  assert.match(d.reason, /^replacement hic-r-/);

  assert.equal(decide(inc({ replacement: { requestId: rid, view: null } })).action, "LOOK_UP");
});

test("overdue funding, or a cancel without a reason → escalate", () => {
  const snap = fx.transfers.A[0];
  const overdue = viewOf(ids.A, [event("e-o", snap, "OVERDUE", "2026-10-07T11:34:49+0000")]);
  assert.match(decide(inc({ original: overdue })).reason, /funding overdue/);
  const cancelled = viewOf(ids.A, [event("e-c", snap, "CANCELLED", "2026-10-07T11:34:49+0000")]);
  assert.match(decide(inc({ original: cancelled })).reason, /without a failure reason/);
});

test("contradictory evidence → escalate", () => {
  const late = event("e-late", fx.transfers.A[2], "PROCESSING", "2026-10-07T12:00:00+0000");
  const d = decide(inc({ original: viewOf(ids.A, [...evidenceOf("A"), late]) }));
  assert.equal(d.action, "ESCALATE");
  assert.match(d.reason, /contradictory/);
});

test("looked up by request_id and not found → re-send with the same request_id", () => {
  const d = decide(inc({ original: null, lookedUp: true }));
  assert.equal(d.action, "RETRY_CREATE");
  assert.match(d.reason, /same request_id/);
});

test("a replacement that is locked but was never created → create it with the same request_id", () => {
  const rid = replacementRequestId(ids.B);
  assert.equal(decide(inc({ replacement: { requestId: rid, view: null, lookedUp: true } })).action, "RETRY_CREATE");
  assert.equal(decide(inc({ replacement: { requestId: rid, view: null } })).action, "LOOK_UP");
});
