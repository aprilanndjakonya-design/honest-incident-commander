import assert from "node:assert/strict";
import { test } from "node:test";
import { investigate, replace } from "../src/incident.ts";
import { Store } from "../src/ledger/store.ts";
import { replacementRequestId } from "../src/payments/policy.ts";
import type { TransferSnapshot } from "../src/payments/types.ts";
import { fakeApi, fx, ids } from "./helpers.ts";

const NOW = "2026-10-07T12:00:00.000Z";
const final = (tag: "A" | "B" | "C") => fx.transfers[tag].at(-1)!;

// B's final state, but failed on a channel timeout: the one failure class that allows a replacement.
const timedOut: TransferSnapshot = {
  ...final("B"),
  failure: { code: "91402", message: "Channel timeout" },
  beneficiary_id: "ben-1", reason: "goods_purchased", reference: "INV-1", transfer_method: "LOCAL", source_currency: "USD",
};

test("A: the transfer and its ledger go into the record, and the payment is confirmed", async () => {
  const store = new Store();
  const { api } = fakeApi([final("A")]);
  const r = await investigate({ api, store, transferId: ids.A, amount: 10, now: NOW });
  assert.equal(r.decision.action, "CONFIRM_PAID");
  assert.equal(store.evidence(ids.A).length, 3); // the transfer, the payout, the fee
  assert.deepEqual(store.decisions(ids.A).map((d) => d.action), ["CONFIRM_PAID"]);
});

test("a lost create response: found by request_id → decided on the real transfer; not found → same request_id again", async () => {
  const store = new Store();
  const { api } = fakeApi([final("A")]);
  assert.equal((await investigate({ api, store, requestId: final("A").request_id, amount: 10, now: NOW })).decision.action, "CONFIRM_PAID");
  assert.equal((await investigate({ api, store, requestId: "hic-never-created", amount: 10, now: NOW })).decision.action, "RETRY_CREATE");
});

test("a channel timeout: one replacement, however often the supplier complains", async () => {
  const store = new Store();
  const { api, created } = fakeApi([timedOut]);
  const first = await investigate({ api, store, transferId: ids.B, amount: 10, now: NOW });
  assert.equal(first.decision.action, "REPLACE");
  const done = await replace({ api, store, original: timedOut, decision: first.decision, now: NOW });
  assert.deepEqual([done.created, done.requestId], [true, replacementRequestId(ids.B)]);

  const second = await investigate({ api, store, transferId: ids.B, amount: 10, now: NOW });
  assert.equal(second.decision.action, "WAIT");
  assert.match(second.decision.reason, /^replacement hic-r-.*in transit/);
  assert.equal((await replace({ api, store, original: timedOut, decision: first.decision, now: NOW })).created, false);
  assert.equal(created.length, 1);
});

test("stopped between the lock and the create: the next run creates the copy once, under the same request_id", async () => {
  const store = new Store();
  const { api, created } = fakeApi([timedOut]);
  const rid = replacementRequestId(ids.B);
  store.lockReplacement(ids.B, rid, NOW); // ...and the process stopped here

  const next = await investigate({ api, store, transferId: ids.B, amount: 10, now: NOW });
  assert.equal(next.decision.action, "RETRY_CREATE");
  const done = await replace({ api, store, original: timedOut, decision: next.decision, now: NOW });
  assert.deepEqual([done.created, done.requestId], [true, rid]);
  assert.equal((await replace({ api, store, original: timedOut, decision: next.decision, now: NOW })).created, false);
  assert.equal(created.length, 1);
});

test("account closed: no replacement is possible from that decision", async () => {
  const store = new Store();
  const { api, created } = fakeApi([{ ...final("B"), beneficiary_id: "ben-1" }]);
  const r = await investigate({ api, store, transferId: ids.B, amount: 10, now: NOW });
  assert.equal(r.decision.action, "ASK_FOR_DETAILS");
  await assert.rejects(replace({ api, store, original: final("B"), decision: r.decision, now: NOW }), /not a replacement decision/);
  assert.equal(created.length, 0);
});
