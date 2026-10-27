// The incident commander: a supplier's message or a webhook in, one checked reply out.
//
//   message → intake (model reads it; facts only) → investigate (evidence → decision, code) → act (code: at most one
//   replacement, under a lock) → draft (model words it) → claim checker → reply
//
// Without a model the commander still decides and acts the same way; replies come from templates and new bank details
// in a message go unnoticed — reading free text is the one thing the model adds to the decision.

import type { Evidence } from "../claims/index.ts";
import { investigate, replace, type Api, type Report } from "../incident.ts";
import type { Store } from "../ledger/store.ts";
import { fromLedger, fromSnapshot, fromWebhook } from "../payments/evidence.ts";
import type { Decision } from "../payments/policy.ts";
import type { TransferSnapshot, WebhookEvent } from "../payments/types.ts";
import { viewOf, type TransferView } from "../payments/view.ts";
import { factsOf, readMessage, type Intake } from "./intake.ts";
import type { Model } from "./model.ts";
import { draftReply, type Draft, type ReplyContext, type TransferFacts } from "./reply.ts";

export interface Invoice {
  key: string;
  requestId: string; // of the original transfer
  transferId: string | null; // null when the create response was lost
  beneficiaryId: string;
  amount: number;
  currency?: string; // USD when absent
  reference: string;
}

export interface SupplierMessage {
  text: string;
  at?: string; // when it arrived; the decision clock (defaults to now)
}

export interface Outcome {
  kind: "message" | "webhook";
  decision: Decision | null; // null for a webhook that needs no decision
  about: string | null; // the transfer the reply is about
  created: string[]; // transfers this step created
  intake: Intake | null;
  draft: Draft | null; // null: nothing to tell the supplier (a redelivery, no change)
  note: string;
}

export const bodyOf = (inv: Invoice, requestId: string) => ({
  beneficiary_id: inv.beneficiaryId,
  request_id: requestId,
  source_currency: inv.currency ?? "USD",
  transfer_currency: inv.currency ?? "USD",
  transfer_amount: inv.amount.toFixed(2),
  transfer_method: "LOCAL",
  reason: "goods_purchased",
  reference: inv.reference,
});

function factsOfTransfer(role: TransferFacts["role"], t: TransferSnapshot | null, id: string, v: TransferView | null): TransferFacts {
  return {
    id,
    role,
    shortRef: t?.short_reference_id ?? null,
    status: v?.status ?? null,
    statusAt: v?.statusAt ?? null,
    history: v?.history.map((h) => ({ status: h.status, at: h.at })) ?? [],
    failure: v?.failure?.message ?? null,
    ledger: { paidOut: v?.ledger.paidOut ?? 0, reversed: v?.ledger.reversed ?? 0, fees: v?.ledger.fees ?? 0 },
  };
}

export class Commander {
  api: Api;
  store: Store;
  model: Model | null;
  notified = new Map<string, string>();
  snapshots = new Map<string, TransferSnapshot>();

  constructor(api: Api, store: Store, model: Model | null = null) {
    this.api = api;
    this.store = store;
    this.model = model;
  }

  // Polls one transfer into the record (status and ledger) and returns what we now know about it.
  async observe(id: string, now: string): Promise<TransferView> {
    const r = await this.api.getTransfer(id);
    if (r.status === 200) {
      this.snapshots.set(id, r.data as TransferSnapshot);
      this.store.addEvidence(fromSnapshot(r.data as TransferSnapshot), now);
    }
    for (const item of await this.api.ledger(id)) this.store.addEvidence(fromLedger(item), now);
    return viewOf(id, this.store.evidence(id));
  }

  evidenceFor(ids: (string | null | undefined)[]): Evidence[] {
    return [...new Set(ids.filter(Boolean) as string[])].flatMap((id) => this.store.evidence(id));
  }

  async onMessage(inv: Invoice, msg: SupplierMessage | null): Promise<Outcome> {
    const now = msg?.at ?? new Date().toISOString();
    let intake: Intake | null = null;
    let unread = false;
    if (this.model && msg) {
      try {
        intake = await readMessage(this.model, msg.text);
      } catch {
        unread = true; // fail closed: policy blocks any payment until a person reads it
      }
    }
    const r: Report = await investigate({
      api: this.api,
      store: this.store,
      transferId: inv.transferId ?? undefined,
      requestId: inv.transferId ? undefined : inv.requestId,
      amount: inv.amount,
      now,
      message: intake ? factsOf(intake) : unread ? { newBankDetails: false, unread } : undefined,
    });
    const d = r.decision;
    if (r.transfer) this.snapshots.set(r.transfer.id, r.transfer);
    if (r.replacement?.transfer) this.snapshots.set(r.replacement.transfer.id, r.replacement.transfer);
    const onReplacement = d.reason.startsWith("replacement ");
    let about = onReplacement ? (r.replacement?.transfer?.id ?? null) : (r.transfer?.id ?? null);
    const created: string[] = [];
    let replacementId = r.replacement?.transfer?.id ?? null;

    if ((d.action === "REPLACE" || d.action === "RETRY_CREATE") && r.transfer) {
      const done = await replace({ api: this.api, store: this.store, original: r.transfer, decision: d, now });
      if (done.created && done.transferId) created.push(done.transferId);
      replacementId = done.transferId ?? replacementId;
      if (replacementId) await this.observe(replacementId, now);
    } else if (d.action === "RETRY_CREATE") {
      // The original was never created: send it again under its own request_id, which Airwallex deduplicates.
      const c = await this.api.createTransfer(bodyOf(inv, inv.requestId));
      if (c.status === 201) {
        inv.transferId = c.data.id as string;
        created.push(inv.transferId);
        about = inv.transferId;
      }
    }

    const original = r.transfer?.id ?? null;
    const transfers: TransferFacts[] = [];
    if (original) transfers.push(factsOfTransfer("original", this.snapshots.get(original) ?? null, original, viewOf(original, this.store.evidence(original))));
    if (replacementId) transfers.push(factsOfTransfer("replacement", this.snapshots.get(replacementId) ?? null, replacementId, viewOf(replacementId, this.store.evidence(replacementId))));
    const ctx: ReplyContext = {
      action: d.action,
      reason: d.reason,
      about: about ?? original ?? inv.requestId,
      invoice: { reference: inv.reference, amount: inv.amount, currency: inv.currency ?? "USD" },
      transfers,
      newBankDetails: !!intake?.new_bank_details,
      supplierText: msg?.text,
    };
    const draft = await draftReply({ model: this.model, ctx, evidence: this.evidenceFor([original, replacementId]) });
    return { kind: "message", decision: d, about, created, intake, draft, note: d.reason };
  }

  // Redeliveries are dropped by the record. A failure starts the incident flow; other events update the supplier only
  // when the transfer's state, ordered by event time, actually changed — and "paid" only once the ledger shows it.
  async onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Outcome> {
    const now = new Date().toISOString();
    const quiet = (note: string): Outcome => ({ kind: "webhook", decision: null, about: ev.data.id, created: [], intake: null, draft: null, note });
    if (!this.store.addEvidence(fromWebhook(ev), now)) return quiet("redelivery ignored");
    if (ev.name.endsWith(".failed")) return this.onMessage(inv, null);
    let view = viewOf(ev.data.id, this.store.evidence(ev.data.id));
    if (!view.status || this.notified.get(ev.data.id) === view.status) return quiet(`still ${view.status}`);
    if (view.failed) return quiet("the failure is handled by the incident flow"); // e.g. a late SENT after FAILED
    if (view.status === "PAID") {
      for (const item of await this.api.ledger(ev.data.id)) this.store.addEvidence(fromLedger(item), now);
      view = viewOf(ev.data.id, this.store.evidence(ev.data.id));
    }
    this.notified.set(ev.data.id, view.status!);
    this.snapshots.set(ev.data.id, ev.data);
    const ctx: ReplyContext = {
      action: "NOTIFY",
      reason: `now ${view.status}`,
      about: ev.data.id,
      invoice: { reference: inv.reference, amount: inv.amount, currency: inv.currency ?? "USD" },
      transfers: [factsOfTransfer(ev.data.id === inv.transferId ? "original" : "replacement", ev.data, ev.data.id, view)],
      newBankDetails: false,
    };
    // Status updates are templated: the model words answers to people, not every status change.
    const draft = await draftReply({ model: null, ctx, evidence: this.evidenceFor([ev.data.id]) });
    if (!draft.claims.length) return quiet(`now ${view.status}, nothing confirmed to report yet`);
    return { kind: "webhook", decision: null, about: ev.data.id, created: [], intake: null, draft, note: `now ${view.status}` };
  }
}
