import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkClaims } from "../src/claims/index.ts";
import { Store } from "../src/ledger/store.ts";
import { paymentRules } from "../src/payments/claim-rules.ts";
import { decide, replacementRequestId } from "../src/payments/policy.ts";
import { viewOf } from "../src/payments/view.ts";
import { evidenceOf, ids } from "./helpers.ts";

const AT = "2026-10-07T12:00:00.000Z";

test("a redelivered item is stored once", () => {
  const s = new Store();
  const [first] = evidenceOf("A");
  assert.equal(s.addEvidence(first, AT), true);
  assert.equal(s.addEvidence(first, AT), false);
  assert.equal(s.evidence(ids.A).length, 1);
  s.close();
});

test("the record is append-only", () => {
  const s = new Store();
  for (const e of evidenceOf("A")) s.addEvidence(e, AT);
  assert.throws(() => s.db.exec("UPDATE evidence SET kind = 'x'"), /append-only/);
  assert.throws(() => s.db.exec("DELETE FROM evidence"), /append-only/);
  s.close();
});

test("the view built from the store equals the view built in memory", () => {
  const s = new Store();
  for (const e of evidenceOf("C")) s.addEvidence(e, AT);
  assert.deepEqual(viewOf(ids.C, s.evidence(ids.C)), viewOf(ids.C, evidenceOf("C")));
  s.close();
});

test("one replacement per incident, even across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "hic-"));
  try {
    const path = join(dir, "hic.sqlite");
    const rid = replacementRequestId(ids.B);
    const first = new Store(path);
    assert.deepEqual(first.lockReplacement(ids.B, rid, AT), { acquired: true, replacementRequestId: rid });
    first.close();

    const restarted = new Store(path);
    assert.deepEqual(restarted.lockReplacement(ids.B, "hic-r-another", AT), { acquired: false, replacementRequestId: rid });
    // The lock is evidence that a "replaced" claim can cite.
    const r = checkClaims([{ kind: "replaced", subject: ids.B, cites: [`lock:${ids.B}`] }], restarted.evidence(ids.B), paymentRules);
    assert.equal(r.ok, true);
    restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decisions are kept in order", () => {
  const s = new Store();
  for (const e of evidenceOf("B")) s.addEvidence(e, AT);
  const d = decide({ key: ids.B, original: viewOf(ids.B, s.evidence(ids.B)), replacement: null, amount: 10, now: AT });
  s.recordDecision(ids.B, d, AT);
  s.recordDecision(ids.B, { action: "WAIT", reason: "supplier asked to confirm the details", cites: [] }, AT);
  assert.deepEqual(s.decisions(ids.B).map((x) => x.action), ["ASK_FOR_DETAILS", "WAIT"]);
  s.close();
});
