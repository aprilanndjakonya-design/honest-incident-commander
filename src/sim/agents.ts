// The two agents the incident runner compares.
//
// ours   the core: evidence in an append-only record, the decision table, one replacement under a lock.
// naive  what a quick automation or a chat agent without a record does: it handles each message on its own, trusts
//        the latest status it is shown, re-sends whenever a transfer looks failed, and creates a fresh request_id
//        whenever it has no transfer id.

import type { AirwallexClient } from "../airwallex/client.ts";
import { investigate, replace } from "../incident.ts";
import { Store } from "../ledger/store.ts";
import { fromWebhook } from "../payments/evidence.ts";
import type { Decision } from "../payments/policy.ts";
import type { TransferStatus, WebhookEvent } from "../payments/types.ts";
import { viewOf } from "../payments/view.ts";

export interface Invoice {
  key: string;
  requestId: string; // of the original transfer
  transferId: string | null; // null when the create response was lost
  beneficiaryId: string;
  amount: number;
  reference: string;
}

export type ReplyAction = "CONFIRM" | "WAIT" | "ASK_DETAILS" | "REPLACE" | "RESEND" | "CREATE_SAME_ID" | "LOOK_UP" | "ESCALATE" | "NOTIFY" | "NONE";

// What the agent tells the supplier, which transfer that is about, and which transfers it created.
export interface Reply {
  action: ReplyAction;
  claims: string[]; // paid | in_transit | failed | replaced
  about: string | null;
  created: string[];
  note: string;
}

export interface Agent {
  name: string;
  onComplaint(inv: Invoice): Promise<Reply>;
  onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Reply>;
  close(): void;
}

export const bodyOf = (inv: Invoice, requestId: string) => ({
  beneficiary_id: inv.beneficiaryId,
  request_id: requestId,
  source_currency: "USD",
  transfer_currency: "USD",
  transfer_amount: inv.amount.toFixed(2),
  transfer_method: "LOCAL",
  reason: "goods_purchased",
  reference: inv.reference,
});

const IN_FLIGHT: string[] = ["SCHEDULED", "PROCESSING", "SENT", "OVERDUE", "CANCELLATION_REQUESTED"];
const claimFor = (status: string): string[] =>
  status === "PAID" ? ["paid"] : IN_FLIGHT.includes(status) ? ["in_transit"] : status === "FAILED" || status === "CANCELLED" ? ["failed"] : [];

export class OurAgent implements Agent {
  name = "ours";
  api: AirwallexClient;
  store = new Store();
  notified = new Map<string, string>();

  constructor(api: AirwallexClient) {
    this.api = api;
  }

  async onComplaint(inv: Invoice): Promise<Reply> {
    const r = await investigate({
      api: this.api,
      store: this.store,
      transferId: inv.transferId ?? undefined,
      requestId: inv.transferId ? undefined : inv.requestId,
      amount: inv.amount,
    });
    const d: Decision = r.decision;
    const onReplacement = d.reason.startsWith("replacement ");
    const about = onReplacement ? (r.replacement?.transfer?.id ?? null) : (r.transfer?.id ?? null);
    const base = { about, created: [] as string[], note: d.reason };
    switch (d.action) {
      case "CONFIRM_PAID":
        return { ...base, action: "CONFIRM", claims: ["paid"] };
      case "WAIT": {
        const view = onReplacement ? r.replacement?.view : r.view;
        return { ...base, action: "WAIT", claims: view?.failed ? ["failed"] : ["in_transit"] };
      }
      case "ASK_FOR_DETAILS":
        return { ...base, action: "ASK_DETAILS", claims: ["failed"] };
      case "REPLACE":
      case "RETRY_CREATE": {
        if (r.transfer) {
          const done = await replace({ api: this.api, store: this.store, original: r.transfer, decision: d });
          return { ...base, action: "REPLACE", claims: d.action === "REPLACE" ? ["failed", "replaced"] : ["replaced"], created: done.created && done.transferId ? [done.transferId] : [] };
        }
        // The original was never created: send it again under its own request_id.
        const c = await this.api.createTransfer(bodyOf(inv, inv.requestId));
        const id = c.status === 201 ? (c.data.id as string) : null;
        if (id) inv.transferId = id;
        return { ...base, action: "CREATE_SAME_ID", claims: [], about: id, created: id ? [id] : [] };
      }
      case "LOOK_UP":
        return { ...base, action: "LOOK_UP", claims: [] };
      default:
        return { ...base, action: "ESCALATE", claims: [] };
    }
  }

  // Redeliveries are dropped by the record. A failure starts the incident flow; other events update the supplier
  // only when the transfer's state, ordered by event time, actually changed.
  async onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Reply> {
    const fresh = this.store.addEvidence(fromWebhook(ev), new Date().toISOString());
    if (!fresh) return { action: "NONE", claims: [], about: ev.data.id, created: [], note: "redelivery ignored" };
    if (ev.name.endsWith(".failed")) return this.onComplaint(inv);
    const view = viewOf(ev.data.id, this.store.evidence(ev.data.id));
    if (!view.status || this.notified.get(ev.data.id) === view.status) {
      return { action: "NONE", claims: [], about: ev.data.id, created: [], note: `still ${view.status}` };
    }
    this.notified.set(ev.data.id, view.status);
    return { action: "NOTIFY", claims: claimFor(view.status), about: ev.data.id, created: [], note: `now ${view.status}` };
  }

  close(): void {
    this.store.close();
  }
}

export class NaiveAgent implements Agent {
  name = "naive";
  api: AirwallexClient;
  seq = 0;

  constructor(api: AirwallexClient) {
    this.api = api;
  }

  async resend(inv: Invoice, why: string): Promise<Reply> {
    const c = await this.api.createTransfer(bodyOf(inv, `${inv.requestId}-n${++this.seq}`));
    const id = c.status === 201 ? (c.data.id as string) : null;
    return { action: "RESEND", claims: ["replaced"], about: id, created: id ? [id] : [], note: why };
  }

  async onComplaint(inv: Invoice): Promise<Reply> {
    if (!inv.transferId) return this.resend(inv, "no transfer id: sent it again");
    const status = (await this.api.getTransfer(inv.transferId)).data.status as TransferStatus;
    if (status === "PAID") return { action: "CONFIRM", claims: ["paid"], about: inv.transferId, created: [], note: "PAID" };
    if (IN_FLIGHT.includes(status)) return { action: "WAIT", claims: ["in_transit"], about: inv.transferId, created: [], note: status };
    return this.resend(inv, `${status}: sent it again`);
  }

  async onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Reply> {
    if (ev.name.endsWith(".failed")) return this.resend(inv, "failed event: sent it again");
    return { action: "NOTIFY", claims: claimFor(ev.data.status), about: ev.data.id, created: [], note: `event says ${ev.data.status}` };
  }

  close(): void {}
}
