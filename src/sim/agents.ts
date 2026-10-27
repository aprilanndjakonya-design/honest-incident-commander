// The agents the incident runner compares.
//
// ours   the commander (src/agent/commander.ts): evidence in an append-only record, the decision table, one
//        replacement under a lock, and — when a model is configured — the model reading the supplier's message and
//        wording the reply, both checked by code.
// naive  what a quick automation or a chat agent without a record does: it handles each message on its own, trusts
//        the latest status it is shown, re-sends whenever a transfer looks failed, and creates a fresh request_id
//        whenever it has no transfer id.

import type { AirwallexClient } from "../airwallex/client.ts";
import { unbackedMentions } from "../claims/index.ts";
import { bodyOf, Commander, type Invoice, type Outcome, type SupplierMessage } from "../agent/commander.ts";
import type { Model } from "../agent/model.ts";
import { Store } from "../ledger/store.ts";
import { paymentLexicon } from "../payments/claim-rules.ts";
import type { TransferStatus, WebhookEvent } from "../payments/types.ts";

export { bodyOf, type Invoice, type SupplierMessage };

export type ReplyAction = "CONFIRM" | "WAIT" | "ASK_DETAILS" | "REPLACE" | "RESEND" | "CREATE_SAME_ID" | "LOOK_UP" | "ESCALATE" | "NOTIFY" | "NONE";

// What the agent tells the supplier, which transfer that is about, and which transfers it created.
export interface Reply {
  action: ReplyAction;
  claims: { kind: string; subject: string | null }[]; // what the reply states, structured; subject null = `about`
  text: string; // the words the supplier gets ("" when nothing is sent)
  about: string | null;
  created: string[];
  note: string;
  model?: { source: "model" | "template"; attempts: number; refused: number; newBankDetails: boolean; instructions: number };
}

export interface Agent {
  name: string;
  onComplaint(inv: Invoice, msg: SupplierMessage): Promise<Reply>;
  onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Reply>;
  close(): void;
}

// Claim words a text makes, negations excluded.
export const claimsInText = (text: string): string[] => unbackedMentions(text, [], paymentLexicon);

const IN_FLIGHT: string[] = ["SCHEDULED", "PROCESSING", "SENT", "OVERDUE", "CANCELLATION_REQUESTED"];
const claimFor = (status: string): string[] =>
  status === "PAID" ? ["paid"] : IN_FLIGHT.includes(status) ? ["in_transit"] : status === "FAILED" || status === "CANCELLED" ? ["failed"] : [];

const ACTION: Record<string, ReplyAction> = {
  CONFIRM_PAID: "CONFIRM", WAIT: "WAIT", ASK_FOR_DETAILS: "ASK_DETAILS", REPLACE: "REPLACE", LOOK_UP: "LOOK_UP", ESCALATE: "ESCALATE",
};

function toReply(o: Outcome): Reply {
  const d = o.decision;
  let action: ReplyAction = o.kind === "webhook" && !d ? (o.draft ? "NOTIFY" : "NONE") : ACTION[d!.action] ?? "ESCALATE";
  if (d?.action === "RETRY_CREATE") action = o.note.startsWith("replacement ") ? "REPLACE" : "CREATE_SAME_ID";
  return {
    action,
    claims: o.draft?.claims.map((c) => ({ kind: c.kind, subject: c.subject })) ?? [],
    text: o.draft?.text ?? "",
    about: o.about,
    created: o.created,
    note: o.note,
    model: o.draft ? {
      source: o.draft.source, attempts: o.draft.attempts, refused: o.draft.refused.length,
      newBankDetails: !!o.intake?.new_bank_details, instructions: o.intake?.instructions_to_us.length ?? 0,
    } : undefined,
  };
}

export class OurAgent implements Agent {
  name = "ours";
  store = new Store();
  commander: Commander;

  constructor(api: AirwallexClient, model: Model | null = null) {
    this.commander = new Commander(api, this.store, model);
  }

  async onComplaint(inv: Invoice, msg: SupplierMessage): Promise<Reply> {
    return toReply(await this.commander.onMessage(inv, msg));
  }

  async onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Reply> {
    return toReply(await this.commander.onWebhook(ev, inv));
  }

  close(): void {
    this.store.close();
  }
}

// Plain wording for the naive agent's claims, so its text is judged the same way as ours.
const NAIVE_TEXT: Record<string, string> = {
  paid: "Your payment has been paid.",
  in_transit: "Your payment is on its way.",
  failed: "Your payment failed.",
  replaced: "We have re-sent the payment.",
};
const naiveText = (claims: string[]) => claims.map((c) => NAIVE_TEXT[c]).join(" ");
const naive = (kinds: string[]) => kinds.map((kind) => ({ kind, subject: null }));

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
    return { action: "RESEND", claims: naive(["replaced"]), text: naiveText(["replaced"]), about: id, created: id ? [id] : [], note: why };
  }

  async onComplaint(inv: Invoice, _msg: SupplierMessage): Promise<Reply> {
    if (!inv.transferId) return this.resend(inv, "no transfer id: sent it again");
    const status = (await this.api.getTransfer(inv.transferId)).data.status as TransferStatus;
    if (status === "PAID") return { action: "CONFIRM", claims: naive(["paid"]), text: naiveText(["paid"]), about: inv.transferId, created: [], note: "PAID" };
    if (IN_FLIGHT.includes(status)) return { action: "WAIT", claims: naive(["in_transit"]), text: naiveText(["in_transit"]), about: inv.transferId, created: [], note: status };
    return this.resend(inv, `${status}: sent it again`);
  }

  async onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Reply> {
    if (ev.name.endsWith(".failed")) return this.resend(inv, "failed event: sent it again");
    return { action: "NOTIFY", claims: naive(claimFor(ev.data.status)), text: naiveText(claimFor(ev.data.status)), about: ev.data.id, created: [], note: `event says ${ev.data.status}` };
  }

  close(): void {}
}
