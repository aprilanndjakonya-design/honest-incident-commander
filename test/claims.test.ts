import assert from "node:assert/strict";
import { test } from "node:test";
import { checkClaims, unbackedMentions, type Claim } from "../src/claims/index.ts";
import { paymentLexicon, paymentRules } from "../src/payments/claim-rules.ts";
import { viewOf } from "../src/payments/view.ts";
import { evidenceOf, ids } from "./helpers.ts";

const all = [...evidenceOf("A"), ...evidenceOf("B"), ...evidenceOf("C")];
const check = (claims: Claim[]) => checkClaims(claims, all, paymentRules);
const reasonOf = (r: ReturnType<typeof check>) => {
  const bad = r.verdicts.find((v) => !v.ok);
  return bad && !bad.ok ? bad.reason : "";
};

test("generic checks fail closed", () => {
  const a = viewOf(ids.A, all);
  const r = check([
    { kind: "teleported", subject: ids.A, cites: [a.statusEvidence!] },
    { kind: "paid", subject: ids.A, cites: [] },
    { kind: "paid", subject: ids.A, cites: ["evt:does-not-exist"] },
    { kind: "paid", subject: ids.A, cites: [viewOf(ids.B, all).statusEvidence!] },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.verdicts.map((v) => (v.ok ? "ok" : v.reason.split(":")[0])),
    ['no rule for claim "teleported"', "cites no evidence", "cites unknown evidence", "cites evidence about another subject"],
  );
});

test("paid: A citing its PAID status and the ledger payout passes", () => {
  const v = viewOf(ids.A, all);
  assert.equal(check([{ kind: "paid", subject: ids.A, cites: [v.statusEvidence!, v.ledger.payoutEvidence[0]] }]).ok, true);
});

test("paid: without the ledger citation it is refused", () => {
  const v = viewOf(ids.A, all);
  assert.match(reasonOf(check([{ kind: "paid", subject: ids.A, cites: [v.statusEvidence!] }])), /ledger payout/);
});

test("paid: C was paid and then returned — citing the old PAID status is refused", () => {
  const v = viewOf(ids.C, all);
  const r = check([{ kind: "paid", subject: ids.C, cites: [v.paidEvidence!, ...v.ledger.payoutEvidence] }]);
  assert.match(reasonOf(r), /latest status is CANCELLED/);
});

test("in_transit: an old PROCESSING report does not make a paid transfer in transit", () => {
  const processing = viewOf(ids.A, all).history[0].evidence;
  assert.match(reasonOf(check([{ kind: "in_transit", subject: ids.A, cites: [processing] }])), /not in transit/);
});

test("failed and refunded: B cites the failure and the reversal; A has nothing to refund", () => {
  const b = viewOf(ids.B, all);
  const r = check([
    { kind: "failed", subject: ids.B, cites: [b.failureEvidence!] },
    { kind: "refunded", subject: ids.B, cites: b.ledger.reversalEvidence },
  ]);
  assert.equal(r.ok, true);
  const a = viewOf(ids.A, all);
  assert.match(reasonOf(check([{ kind: "refunded", subject: ids.A, cites: a.ledger.payoutEvidence }])), /no reversal/);
});

test("free text: 'paid' without a paid claim is flagged; a negation is not", () => {
  assert.deepEqual(unbackedMentions("Good news: your invoice has been paid.", [], paymentLexicon), ["paid"]);
  assert.deepEqual(unbackedMentions("The transfer has not been paid yet.", [], paymentLexicon), []);
  assert.deepEqual(unbackedMentions("It is on its way.", [{ kind: "in_transit", subject: ids.A, cites: [] }], paymentLexicon), []);
  assert.deepEqual(unbackedMentions("No worries, it has been paid and refunded.", [], paymentLexicon), ["paid", "refunded"]);
});
