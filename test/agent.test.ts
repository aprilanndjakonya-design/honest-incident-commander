import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Commander, type Invoice } from "../src/agent/commander.ts";
import type { Intake } from "../src/agent/intake.ts";
import { BudgetExceededError, ClaudeModel, Meter, type JsonRequest, type Model } from "../src/agent/model.ts";
import { vet } from "../src/agent/reply.ts";
import { Store } from "../src/ledger/store.ts";
import { supportedClaims } from "../src/payments/claim-rules.ts";
import { fromLedger, fromSnapshot } from "../src/payments/evidence.ts";
import { withMessage } from "../src/payments/policy.ts";
import type { TransferSnapshot } from "../src/payments/types.ts";
import { fakeApi, fx, ids } from "./helpers.ts";

const final = (tag: "A" | "B" | "C") => fx.transfers[tag].at(-1)!;
const NOW = "2026-10-07T12:00:00.000Z";
const invoiceFor = (t: TransferSnapshot): Invoice => ({
  key: t.id, requestId: t.request_id, transferId: t.id, beneficiaryId: "ben-1", amount: 10, reference: "INV-7",
});
const msg = (text: string) => ({ text, at: NOW });

// A model that answers from a script, in order; an Error in the script is thrown.
class ScriptedModel implements Model {
  answers: unknown[];
  calls: JsonRequest[] = [];
  constructor(answers: unknown[]) {
    this.answers = answers;
  }
  async json<T>(req: JsonRequest): Promise<T> {
    this.calls.push(req);
    const a = this.answers.shift();
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`no scripted answer for ${req.purpose}`);
    return a as T;
  }
}

const intake = (over: Partial<Intake> = {}): Intake => ({
  intent: "not_received", invoice_refs: ["INV-7"], transfer_refs: [], new_bank_details: false,
  asks_us_to_pay_again: false, sender_assertions: [], instructions_to_us: [], ...over,
});

// B's final state, failed on a channel timeout: the one failure class that allows a replacement.
const timedOut: TransferSnapshot = {
  ...final("B"),
  failure: { code: "91402", message: "Channel timeout" },
  beneficiary_id: "ben-1", reason: "goods_purchased", reference: "INV-7", transfer_method: "LOCAL", source_currency: "USD",
};

test("without a model: templates word every decision, and each passes the claim checker", async () => {
  const processing = { ...fx.transfers.A[0] };
  const cases: [TransferSnapshot, string, string[], RegExp][] = [
    [final("A"), "CONFIRM_PAID", ["paid"], /was paid at .* UTC/],
    [final("B"), "ASK_FOR_DETAILS", ["failed"], /Account closed.*contact we have on file/],
    [final("C"), "ASK_FOR_DETAILS", ["failed"], /Beneficiary bank returned/],
    [processing, "WAIT", ["in_transit"], /in transit: status PROCESSING/],
  ];
  for (const [t, action, kinds, text] of cases) {
    const store = new Store();
    const c = new Commander(fakeApi([t]).api, store, null);
    const o = await c.onMessage(invoiceFor(t), msg("Where is our money?"));
    assert.equal(o.decision!.action, action, t.status);
    assert.equal(o.draft!.source, "template");
    assert.deepEqual(o.draft!.claims.map((x) => x.kind), kinds);
    assert.match(o.draft!.text, text);
    assert.match(o.draft!.text, new RegExp(t.short_reference_id!));
    assert.deepEqual(vet(o.draft!.text, o.draft!.claims, store.evidence(t.id)), []);
    store.close();
  }
});

test("a model draft that says 'paid' about a failed transfer is refused; the corrected draft goes out", async () => {
  const b = final("B");
  const evidence = [fromSnapshot(b), ...fx.ledger.filter((l) => l.source_id === b.id).map(fromLedger)];
  const failed = supportedClaims([b.id], evidence).find((c) => c.kind === "failed")!;
  const model = new ScriptedModel([
    intake(),
    { reply: "Good news: your payment was paid yesterday.", claims: [] },
    { reply: `Payment ${b.short_reference_id} failed: Account closed. Please confirm your bank details through the contact we have on file.`, claims: [failed] },
  ]);
  const store = new Store();
  const o = await new Commander(fakeApi([b]).api, store, model).onMessage(invoiceFor(b), msg("Not received."));
  assert.equal(o.draft!.source, "model");
  assert.equal(o.draft!.refused.length, 1);
  assert.match(o.draft!.refused[0].join(" "), /states "paid"/);
  assert.match(model.calls[2].user, /REFUSED BY THE CLAIM CHECKER/);
  assert.match(model.calls[0].user, /<supplier_message>\nNot received.\n<\/supplier_message>/);
  store.close();
});

test("a claim with a forged citation is refused, twice → the template goes out; a model error → the template", async () => {
  const a = final("A");
  const forged = { kind: "paid", subject: a.id, cites: ["evt:made-up"] };
  for (const answers of [
    [intake(), { reply: "It was paid.", claims: [forged] }, { reply: "It was paid.", claims: [forged] }],
    [intake(), new Error("refused")],
  ]) {
    const store = new Store();
    const o = await new Commander(fakeApi([a]).api, store, new ScriptedModel(answers)).onMessage(invoiceFor(a), msg("?"));
    assert.equal(o.draft!.source, "template");
    assert.deepEqual(o.draft!.claims.map((c) => c.kind), ["paid"]);
    store.close();
  }
});

test("new bank details in the message: escalate, pay nothing, and say details are verified through the contact on file", async () => {
  const { api, created } = fakeApi([timedOut]);
  const store = new Store();
  const model = new ScriptedModel([intake({ intent: "bank_details_change", new_bank_details: true }), new Error("offline")]);
  const o = await new Commander(api, store, model).onMessage(invoiceFor(timedOut), msg("Pay to our new account 987654321."));
  assert.equal(o.decision!.action, "ESCALATE");
  assert.match(o.decision!.reason, /new bank details arrived in a message/);
  assert.deepEqual(created, []);
  assert.match(o.draft!.text, /never change payment details based on a message/);
  assert.equal(store.replacementFor(timedOut.id), null);
  store.close();
});

test("the same timeout without new details: one replacement; the next message creates nothing", async () => {
  const { api, created } = fakeApi([timedOut]);
  const store = new Store();
  const c = new Commander(api, store, null);
  const first = await c.onMessage(invoiceFor(timedOut), msg("Not received."));
  assert.equal(first.decision!.action, "REPLACE");
  assert.equal(created.length, 1);
  assert.deepEqual(first.draft!.claims.map((x) => x.kind).sort(), ["failed", "replaced"]);
  assert.match(first.draft!.text, /sent one replacement transfer, reference new-1/);
  const second = await c.onMessage(invoiceFor(timedOut), msg("Still nothing."));
  assert.equal(second.decision!.action, "WAIT");
  assert.equal(created.length, 1);
  assert.deepEqual(second.draft!.claims.map((x) => `${x.kind}:${x.subject}`), ["in_transit:new-1"]);
  store.close();
});

test("withMessage escalates only on new bank details", () => {
  const d = { action: "WAIT" as const, reason: "in transit", cites: ["x"] };
  assert.equal(withMessage(d, { newBankDetails: false }), d);
  assert.equal(withMessage(d, undefined), d);
  assert.equal(withMessage(d, { newBankDetails: true }).action, "ESCALATE");
});

test("the budget: spend persists, and a call past the cap is refused before it reaches the API", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hic-")), "spend.json");
  const meter = new Meter(path, 0.01);
  meter.add(0.006, { purpose: "t" });
  assert.equal(new Meter(path, 0.01).spent(), 0.006);
  meter.check();
  meter.add(0.006, { purpose: "t" });
  let reached = false;
  const client = { messages: { create: async () => { reached = true; throw new Error("unreachable"); } } };
  const model = new ClaudeModel(client as never, "claude-opus-5-5", meter);
  await assert.rejects(model.json({ purpose: "t", system: "", user: "", schema: {} }), BudgetExceededError);
  assert.equal(reached, false);
});

test("supported claims: A paid; B failed and refunded; C failed — its old PAID is no longer claimable", () => {
  const ev = (t: TransferSnapshot) => [fromSnapshot(t), ...fx.ledger.filter((l) => l.source_id === t.id).map(fromLedger)];
  const kinds = (tag: "A" | "B" | "C") => supportedClaims([ids[tag]], [...fx.transfers[tag].map(fromSnapshot), ...ev(final(tag))]).map((c) => c.kind);
  assert.deepEqual(kinds("A"), ["paid"]);
  assert.deepEqual(kinds("B"), ["failed", "refunded"]);
  assert.deepEqual(kinds("C"), ["failed", "refunded"]);
});

test("a message the model could not read blocks the replacement: a person reads it first", async () => {
  const { api, created } = fakeApi([timedOut]);
  const store = new Store();
  const o = await new Commander(api, store, new ScriptedModel([new Error("402 credits"), new Error("402 credits")]))
    .onMessage(invoiceFor(timedOut), msg("Not received."));
  assert.equal(o.decision!.action, "ESCALATE");
  assert.match(o.decision!.reason, /could not be read/);
  assert.deepEqual(created, []);
  assert.equal(o.draft!.source, "template");
  store.close();
});
