// One incident end to end: gather the evidence from Airwallex into the record, decide, and — only for a REPLACE
// decision, only once — create the replacement.

import type { Store } from "./ledger/store.ts";
import { fromLedger, fromSnapshot } from "./payments/evidence.ts";
import { decide, type Decision } from "./payments/policy.ts";
import type { LedgerItem, TransferSnapshot } from "./payments/types.ts";
import { viewOf, type TransferView } from "./payments/view.ts";

// The calls the flow needs. AirwallexClient provides them; tests pass a fake.
export interface Api {
  getTransfer(id: string): Promise<{ status: number; data: any }>;
  findByRequestId(requestId: string): Promise<TransferSnapshot | null>;
  ledger(transferId: string): Promise<LedgerItem[]>;
  createTransfer(body: Record<string, unknown>): Promise<{ status: number; data: any }>;
}

export interface Report {
  key: string;
  transfer: TransferSnapshot | null;
  view: TransferView | null;
  replacement: { requestId: string; transfer: TransferSnapshot | null; view: TransferView | null } | null;
  decision: Decision;
}

async function collect(api: Api, store: Store, transfer: TransferSnapshot, now: string): Promise<TransferView> {
  store.addEvidence(fromSnapshot(transfer), now);
  for (const item of await api.ledger(transfer.id)) store.addEvidence(fromLedger(item), now);
  return viewOf(transfer.id, store.evidence(transfer.id));
}

export async function investigate(opts: {
  api: Api;
  store: Store;
  transferId?: string;
  requestId?: string;
  amount: number;
  now?: string;
  maxTransitHours?: number;
}): Promise<Report> {
  const now = opts.now ?? new Date().toISOString();
  let transfer: TransferSnapshot | null = null;
  let lookedUp = false;
  if (opts.transferId) {
    const r = await opts.api.getTransfer(opts.transferId);
    if (r.status === 200) transfer = r.data as TransferSnapshot;
    else if (r.status !== 404) throw new Error(`get transfer: HTTP ${r.status} ${r.data?.code ?? ""}`.trim());
  } else if (opts.requestId) {
    transfer = await opts.api.findByRequestId(opts.requestId);
    lookedUp = true;
  } else {
    throw new Error("transferId or requestId is required");
  }

  const key = transfer?.id ?? opts.transferId ?? opts.requestId!;
  const view = transfer ? await collect(opts.api, opts.store, transfer, now) : null;

  let replacement: Report["replacement"] = null;
  const replacementRequestId = transfer ? opts.store.replacementFor(transfer.id) : null;
  if (replacementRequestId) {
    const rt = await opts.api.findByRequestId(replacementRequestId);
    replacement = { requestId: replacementRequestId, transfer: rt, view: rt ? await collect(opts.api, opts.store, rt, now) : null };
  }

  const decision = decide({
    key,
    original: view,
    lookedUp,
    replacement: replacement && { requestId: replacement.requestId, view: replacement.view, lookedUp: true },
    amount: opts.amount,
    now,
    maxTransitHours: opts.maxTransitHours,
  });
  opts.store.recordDecision(key, decision, now);
  return { key, transfer, view, replacement, decision };
}

// Carries out a REPLACE decision (or RETRY_CREATE for a locked replacement): the lock first, then the copy under the
// deterministic request_id. A second call creates nothing new; a call after a crash between the two steps creates
// the missing copy under the same request_id, which Airwallex would refuse as a duplicate if it existed.
export async function replace(opts: {
  api: Api;
  store: Store;
  original: TransferSnapshot;
  decision: Decision;
  now?: string;
}): Promise<{ requestId: string; transferId: string | null; created: boolean }> {
  const { decision, original: o } = opts;
  const requestId = decision.replacementRequestId ?? opts.store.replacementFor(o.id);
  if (!["REPLACE", "RETRY_CREATE"].includes(decision.action) || !requestId) throw new Error("not a replacement decision");
  if (!o.beneficiary_id || !o.transfer_amount || !o.transfer_currency) throw new Error("the original lacks beneficiary or amount");
  const now = opts.now ?? new Date().toISOString();

  const lock = opts.store.lockReplacement(o.id, requestId, now);
  if (!lock.acquired) {
    const existing = await opts.api.findByRequestId(lock.replacementRequestId);
    if (existing) return { requestId: lock.replacementRequestId, transferId: existing.id, created: false };
    // Locked but never created (the process stopped between the two steps): the same request_id is safe to send.
  }
  const r = await opts.api.createTransfer({
    beneficiary_id: o.beneficiary_id,
    request_id: lock.replacementRequestId,
    source_currency: o.source_currency ?? o.transfer_currency,
    transfer_currency: o.transfer_currency,
    transfer_amount: String(o.transfer_amount),
    transfer_method: o.transfer_method ?? "LOCAL",
    reason: o.reason ?? "goods_purchased",
    reference: o.reference ?? "replacement",
  });
  if (r.status === 201) return { requestId: lock.replacementRequestId, transferId: r.data.id, created: true };
  if (r.status === 400 && r.data?.code === "duplicate_request_id") {
    return { requestId: lock.replacementRequestId, transferId: r.data.details?.id ?? null, created: false };
  }
  throw new Error(`create replacement: HTTP ${r.status} ${r.data?.code ?? ""}`.trim());
}
