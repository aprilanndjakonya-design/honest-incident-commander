// Airwallex payout transfer types — only the fields the core reads.

export const STATUSES = [
  "SCHEDULED", "OVERDUE", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLATION_REQUESTED", "CANCELLED",
] as const;
export type TransferStatus = (typeof STATUSES)[number];

export interface Failure {
  code?: string;
  message?: string;
  details?: { type?: string };
}

// GET /api/v1/transfers/{id}; also the `data` of a payout.transfer.* webhook event.
export interface TransferSnapshot {
  id: string;
  request_id: string;
  status: TransferStatus;
  updated_at: string;
  created_at?: string;
  short_reference_id?: string;
  transfer_amount?: number;
  transfer_currency?: string;
  failure?: Failure | null;
  // what a replacement copies
  beneficiary_id?: string;
  source_currency?: string;
  transfer_method?: string;
  reason?: string;
  reference?: string;
}

// Webhook envelope as delivered by the sandbox (API version 2026-08-21).
export interface WebhookEvent {
  id: string;
  name: string;
  created_at: string;
  data: TransferSnapshot;
}

// GET /api/v1/financial_transactions?source_id={transfer id}
export interface LedgerItem {
  id: string;
  source_id: string;
  transaction_type: string; // PAYOUT, FEE, PAYOUT_REVERSAL, ...
  amount: number;
  currency: string;
  status: string;
  created_at: string;
}
