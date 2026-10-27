// Recorded sandbox data (7 Oct 2026) as evidence, plus small builders for cases the sandbox cannot produce on demand.

import { readFileSync } from "node:fs";
import type { Evidence } from "../src/claims/index.ts";
import type { Api } from "../src/incident.ts";
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

// An in-memory Airwallex: transfers by id, the recorded ledger, and request_id idempotency on create.
export function fakeApi(transfers: TransferSnapshot[]) {
  const byId = new Map(transfers.map((t) => [t.id, t]));
  const created: Record<string, unknown>[] = [];
  const api: Api = {
    async getTransfer(id) {
      const t = byId.get(id);
      return t ? { status: 200, data: t } : { status: 404, data: { code: "resource_not_found" } };
    },
    async findByRequestId(rid) {
      return [...byId.values()].find((t) => t.request_id === rid) ?? null;
    },
    async ledger(id) {
      return fx.ledger.filter((l) => l.source_id === id);
    },
    async createTransfer(body) {
      const existing = [...byId.values()].find((t) => t.request_id === body.request_id);
      if (existing) return { status: 400, data: { code: "duplicate_request_id", details: { id: existing.id, request_id: body.request_id } } };
      created.push(body);
      const t: TransferSnapshot = {
        id: `new-${created.length}`, request_id: String(body.request_id), status: "SCHEDULED",
        updated_at: "2026-10-07T12:00:00+0000", transfer_amount: 10, transfer_currency: "USD",
      };
      byId.set(t.id, t);
      return { status: 201, data: t };
    },
  };
  return { api, created, byId };
}

