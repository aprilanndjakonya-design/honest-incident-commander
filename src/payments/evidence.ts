// Turns what Airwallex tells us — webhook events, polled transfers, ledger entries — into evidence items.

import type { Evidence } from "../claims/index.ts";
import type { LedgerItem, TransferSnapshot, WebhookEvent } from "./types.ts";

// Airwallex writes offsets as +0000; normalise to UTC ISO 8601 so times compare as strings.
export function isoTime(t: string): string {
  return new Date(t.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")).toISOString();
}

function statusData(s: TransferSnapshot, source: string): Record<string, unknown> {
  return {
    status: s.status,
    failure: s.failure ?? null,
    request_id: s.request_id,
    short_reference_id: s.short_reference_id ?? null,
    amount: s.transfer_amount ?? null,
    currency: s.transfer_currency ?? null,
    source,
  };
}

export function fromWebhook(ev: WebhookEvent): Evidence {
  return {
    id: `evt:${ev.id}`,
    kind: "status",
    subject: ev.data.id,
    at: isoTime(ev.created_at),
    data: { ...statusData(ev.data, "webhook"), event: ev.name },
  };
}

export function fromSnapshot(s: TransferSnapshot): Evidence {
  return {
    id: `poll:${s.id}:${s.status}:${s.updated_at}`,
    kind: "status",
    subject: s.id,
    at: isoTime(s.updated_at),
    data: statusData(s, "poll"),
  };
}

export function fromLedger(item: LedgerItem): Evidence {
  return {
    id: `ftx:${item.id}`,
    kind: "ledger",
    subject: item.source_id,
    at: isoTime(item.created_at),
    data: { type: item.transaction_type, amount: item.amount, currency: item.currency, status: item.status },
  };
}
