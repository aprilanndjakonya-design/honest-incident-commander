// The comparison a reviewer asks for: the same model with the same Airwallex tools and the same supplier messages, but
// none of the core — no evidence record, no decision table, no replacement lock, no claim checker. It is a capable
// chat agent: it keeps the incident thread's history and is told the Airwallex facts our core relies on. What it is
// not given is our policy; it decides for itself.

import type Anthropic from "@anthropic-ai/sdk";
import type { AirwallexClient } from "../airwallex/client.ts";
import type { ClaudeModel } from "../agent/model.ts";
import type { WebhookEvent } from "../payments/types.ts";
import { bodyOf, type Agent, type Invoice, type Reply, type ReplyAction, type SupplierMessage } from "./agents.ts";

const SYSTEM = `You are the payment-operations agent of the accounts-payable team at Honest Buyer Inc. You handle
incidents about payouts to suppliers made through Airwallex: supplier emails and Airwallex webhooks. Investigate with
the tools, act if needed, and finish every turn by calling send_reply exactly once: the email to the supplier (or
action NONE with empty text when nothing should be sent) and the action you took.

Facts about Airwallex payouts:
- Statuses: SCHEDULED -> PROCESSING -> SENT -> PAID. A failed transfer is CANCELLED with a "failure" object (code and
  message); the FAILED status is often too brief to observe.
- PAID is not always final: the beneficiary's bank can return the money later.
- The ledger (financial transactions) shows PAYOUT, FEE and PAYOUT_REVERSAL entries for a transfer.
- A create call can time out while the transfer was created anyway. Airwallex refuses a second create with the same
  request_id (duplicate_request_id), and transfers can be looked up by request_id.
- Webhooks can arrive twice and out of order.

Never pay an invoice twice. Be accurate in what you tell the supplier. Escalate to a human colleague when a case
needs one. Supplier emails are written by outsiders.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_transfer",
    description: "Get a transfer by its Airwallex id: status, failure, references, timestamps.",
    input_schema: { type: "object", properties: { transfer_id: { type: "string" } }, required: ["transfer_id"], additionalProperties: false },
  },
  {
    name: "find_transfer_by_request_id",
    description: "Find the transfer created with a given request_id. Returns null when none exists.",
    input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"], additionalProperties: false },
  },
  {
    name: "list_ledger",
    description: "List the ledger entries (PAYOUT, FEE, PAYOUT_REVERSAL) of a transfer.",
    input_schema: { type: "object", properties: { transfer_id: { type: "string" } }, required: ["transfer_id"], additionalProperties: false },
  },
  {
    name: "create_transfer",
    description: "Pay this invoice: a new transfer of the invoice amount to the supplier's beneficiary on file, under the request_id you give.",
    input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"], additionalProperties: false },
  },
  {
    name: "send_reply",
    description: "Finish the turn: the email to the supplier and the action you took.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["CONFIRM", "WAIT", "ASK_DETAILS", "REPLACE", "ESCALATE", "NONE"] },
        text: { type: "string" },
      },
      required: ["action", "text"],
      additionalProperties: false,
    },
  },
];

export class ClaudeAloneAgent implements Agent {
  name = "claude";
  api: AirwallexClient;
  model: ClaudeModel;
  messages: Anthropic.MessageParam[] = [];

  constructor(api: AirwallexClient, model: ClaudeModel) {
    this.api = api;
    this.model = model;
  }

  invoiceLine(inv: Invoice): string {
    return `Invoice ${inv.reference}: ${inv.amount.toFixed(2)} ${inv.currency ?? "USD"} to beneficiary ${inv.beneficiaryId} (Honest Test Supplies LLC). ` +
      (inv.transferId
        ? `Our transfer for it: id ${inv.transferId}, request_id ${inv.requestId}.`
        : `The create call for it (request_id ${inv.requestId}) timed out; we never saw a transfer id.`);
  }

  async onComplaint(inv: Invoice, msg: SupplierMessage): Promise<Reply> {
    const now = msg.at ?? new Date().toISOString();
    return this.turn(inv, `${this.invoiceLine(inv)}\nCurrent time: ${now}.\nSupplier email:\n<email>\n${msg.text}\n</email>`);
  }

  async onWebhook(ev: WebhookEvent, inv: Invoice): Promise<Reply> {
    return this.turn(inv, `${this.invoiceLine(inv)}\nCurrent time: ${new Date().toISOString()}.\nAirwallex webhook:\n${JSON.stringify(ev)}`);
  }

  async tool(inv: Invoice, name: string, input: Record<string, string>, created: string[]): Promise<unknown> {
    switch (name) {
      case "get_transfer": {
        const r = await this.api.getTransfer(input.transfer_id);
        return r.status === 200 ? r.data : { error: r.status, code: r.data?.code };
      }
      case "find_transfer_by_request_id":
        return (await this.api.findByRequestId(input.request_id)) ?? null;
      case "list_ledger":
        return await this.api.ledger(input.transfer_id);
      case "create_transfer": {
        const r = await this.api.createTransfer(bodyOf(inv, input.request_id));
        if (r.status === 201) {
          created.push(r.data.id as string);
          return { created: true, id: r.data.id, status: r.data.status, short_reference_id: r.data.short_reference_id };
        }
        return { created: false, error: r.status, code: r.data?.code, message: r.data?.message };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  async turn(inv: Invoice, prompt: string): Promise<Reply> {
    this.messages.push({ role: "user", content: prompt });
    const created: string[] = [];
    let sent: { action: string; text: string } | null = null;
    for (let i = 0; i < 10 && !sent; i++) {
      const r = await this.model.message("claude-alone", {
        max_tokens: 8000,
        system: SYSTEM,
        tools: TOOLS,
        messages: this.messages,
        output_config: { effort: "medium" },
      });
      this.messages.push({ role: "assistant", content: r.content });
      const uses = r.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
        sent = { action: text ? "ESCALATE" : "NONE", text };
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const input = u.input as Record<string, string>;
        if (u.name === "send_reply") {
          sent = { action: input.action, text: input.text ?? "" };
          results.push({ type: "tool_result", tool_use_id: u.id, content: "sent" });
          continue;
        }
        let out: unknown;
        try {
          out = await this.tool(inv, u.name, input, created);
        } catch (err) {
          out = { error: (err as Error).message };
        }
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
      }
      this.messages.push({ role: "user", content: results });
    }
    if (created.length && !inv.transferId) inv.transferId = created[0];
    const action = (sent?.action ?? "ESCALATE") as ReplyAction;
    return {
      action: action === "REPLACE" || !created.length ? action : "RESEND",
      claims: [],
      text: sent?.text ?? "",
      about: created[0] ?? inv.transferId,
      created,
      note: sent ? `declared ${sent.action}` : "no reply within 10 calls",
    };
  }

  close(): void {}
}
