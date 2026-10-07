import assert from "node:assert/strict";
import { test } from "node:test";
import { fromSnapshot } from "../src/payments/evidence.ts";
import { viewOf } from "../src/payments/view.ts";
import { event, evidenceOf, fx, ids } from "./helpers.ts";

test("A: paid, with the payout and the fee settled in the ledger", () => {
  const v = viewOf(ids.A, evidenceOf("A"));
  assert.equal(v.status, "PAID");
  assert.equal(v.failed, false);
  assert.ok(v.paidEvidence);
  assert.deepEqual([v.ledger.paidOut, v.ledger.fees, v.ledger.reversed], [10, 3, 0]);
  assert.deepEqual(v.history.map((h) => h.status), ["PROCESSING", "SENT", "PAID"]);
});

test("B: a failure is a CANCELLED transfer with a failure object, and the payout is reversed", () => {
  const v = viewOf(ids.B, evidenceOf("B"));
  assert.equal(v.status, "CANCELLED");
  assert.equal(v.failed, true);
  assert.equal(v.failure?.code, "90701");
  assert.equal(v.failure?.message, "Account closed");
  assert.equal(v.ledger.reversed, 10);
  assert.equal(v.paidThenFailed, false);
});

test("C: PAID is not final — a return after PAID is a failure", () => {
  const v = viewOf(ids.C, evidenceOf("C"));
  assert.equal(v.status, "CANCELLED");
  assert.equal(v.paidThenFailed, true);
  assert.equal(v.failure?.message, "Beneficiary bank returned");
  assert.deepEqual([v.ledger.paidOut, v.ledger.reversed], [10, 10]);
});

test("arrival order does not matter", () => {
  const ev = evidenceOf("C");
  const forward = viewOf(ids.C, ev);
  const backward = viewOf(ids.C, [...ev].reverse());
  assert.deepEqual(backward, forward);
});

test("a redelivered webhook and a poll of the same state are one fact", () => {
  const snap = fx.transfers.A[2]; // PAID
  const paidEvent = event("e-paid", snap, "PAID", snap.updated_at);
  const v = viewOf(ids.A, [...evidenceOf("A"), paidEvent, paidEvent]);
  assert.deepEqual(v.history.map((h) => h.status), ["PROCESSING", "SENT", "PAID"]);
});

test("FAILED and CANCELLED in the same second: lifecycle order decides", () => {
  const snap = fx.transfers.B[1]; // SENT
  const failure = { code: "90701", message: "Account closed", details: { type: "INCORRECT_ROUTING" } };
  const t = "2026-10-07T11:35:43+0000";
  const failed = event("e-failed", snap, "FAILED", t, failure);
  const cancelled = event("e-cancelled", snap, "CANCELLED", t, failure);
  const before = fx.transfers.B.slice(0, 2).map(fromSnapshot); // PROCESSING, SENT
  for (const order of [[failed, cancelled], [cancelled, failed]]) {
    const v = viewOf(ids.B, [...before, ...order]);
    assert.equal(v.status, "CANCELLED");
    assert.equal(v.failed, true);
    assert.equal(v.conflict, null);
  }
});

test("a status that goes backwards in time is a conflict", () => {
  const paid = fx.transfers.A[2];
  const late = event("e-processing-late", paid, "PROCESSING", "2026-10-07T12:00:00+0000");
  const v = viewOf(ids.A, [...evidenceOf("A"), late]);
  assert.match(v.conflict ?? "", /PROCESSING .* after PAID/);
  assert.equal(v.conflictEvidence.length, 2);
});
