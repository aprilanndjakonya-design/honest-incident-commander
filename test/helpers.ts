// Recorded sandbox data (7 Oct 2026) as evidence, plus small builders for cases the sandbox cannot produce on demand.

import { readFileSync } from "node:fs";
import type { Evidence } from "../src/claims/index.ts";
import { fromLedger, fromSnapshot, fromWebhook } from "../src/payments/evidence.ts";
import type { LedgerItem, TransferSnapshot, TransferStatus } from "../src/payments/types.ts";

interface Fixture {
  transfers: Record<"A" | "B" | "C", TransferSnapshot[]>;
  ledger: LedgerItem[];
  duplicate_request_id_error: { code: string; details: { id: string; request_id: string } };
}

export const fx = JSON.parse(
  readFileSync(new URL("./fixtures/sandbox-2026-10-07.json", import.meta.url), "utf8"),
) as Fixture;

// A: paid. B: failed after SENT ("Account closed"). C: PAID, then returned ("Beneficiary bank returned").
export const ids = { A: fx.transfers.A[0].id, B: fx.transfers.B[0].id, C: fx.transfers.C[0].id };

export function evidenceOf(tag: "A" | "B" | "C", opts: { ledger?: boolean } = {}): Evidence[] {
  const id = ids[tag];
  const status = fx.transfers[tag].map(fromSnapshot);
  const ledger = opts.ledger === false ? [] : fx.ledger.filter((l) => l.source_id === id).map(fromLedger);
  return [...status, ...ledger];
}

// A webhook event the way the sandbox delivers it, built from a snapshot.
export function event(eventId: string, snapshot: TransferSnapshot, status: TransferStatus, createdAt: string, failure: TransferSnapshot["failure"] = null): Evidence {
  return fromWebhook({
    id: eventId,
    name: `payout.transfer.${status.toLowerCase()}`,
    created_at: createdAt,
    data: { ...snapshot, status, updated_at: createdAt, failure },
  });
}

export function ledgerEntry(id: string, transferId: string, type: string, amount: number, at: string): Evidence {
  return fromLedger({ id, source_id: transferId, transaction_type: type, amount, currency: "USD", status: "SETTLED", created_at: at });
}

export const hoursAfter = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
