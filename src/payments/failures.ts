// What a payout failure means for the next step.
//
//   DETAILS  the beneficiary's bank details are wrong or stale: ask the supplier before paying again
//   RETRY    a transient channel problem: one replacement with the same details is reasonable
//   STOP     requested, restricted or duplicate: never pay again automatically
//   UNKNOWN  anything we cannot recognise: a human decides (fail closed)

import type { Failure } from "./types.ts";

export type FailureClass = "DETAILS" | "RETRY" | "STOP" | "UNKNOWN";

// Codes seen in the sandbox on 7 Oct 2026. There `details.type` is always INCORRECT_ROUTING whatever failure_type
// the simulation was given, so the code and the message are read first.
const BY_CODE: Record<string, string> = {
  "90701": "ACCOUNT_CLOSED",
  "90802": "BENEFICIARY_BANK_RETURNED",
  "99902": "OTHER",
};

const BY_MESSAGE: [RegExp, string][] = [
  [/account closed/i, "ACCOUNT_CLOSED"],
  [/bank returned/i, "BENEFICIARY_BANK_RETURNED"],
  [/name mismatch/i, "BENEFICIARY_NAME_MISMATCH"],
  [/currency mismatch/i, "ACCOUNT_CURRENCY_MISMATCH"],
  [/timeout|timed out/i, "CHANNEL_TIMEOUT"],
  [/duplicat/i, "DUPLICATION_RETURN"],
  [/recall/i, "RECALL_REQUESTED"],
];

const CLASS: Record<string, FailureClass> = {
  ACCOUNT_CLOSED: "DETAILS",
  ACCOUNT_CURRENCY_MISMATCH: "DETAILS",
  ACCOUNT_INACTIVE_OR_DORMANT: "DETAILS",
  BENEFICIARY_NAME_MISMATCH: "DETAILS",
  BENEFICIARY_BANK_RETURNED: "DETAILS",
  INCORRECT_ROUTING: "DETAILS",
  INVALID_ACCOUNT_NAME_OR_NUMBER: "DETAILS",
  CHANNEL_TIMEOUT: "RETRY",
  ACCOUNT_UNDER_RESTRICTION: "STOP",
  BENEFICIARY_REQUESTED: "STOP",
  CARD_ISSUER_ERROR: "STOP",
  CHANNEL_POLICY: "STOP",
  CLIENT_REQUESTED: "STOP",
  DUPLICATION_RETURN: "STOP",
  RECALL_REQUESTED: "STOP",
};

export function failureType(f: Failure | null): string {
  if (!f) return "UNKNOWN";
  if (f.code && BY_CODE[f.code]) return BY_CODE[f.code];
  const byMessage = BY_MESSAGE.find(([re]) => re.test(f.message ?? ""));
  if (byMessage) return byMessage[1];
  return f.details?.type ?? "UNKNOWN";
}

export function classify(f: Failure | null): { type: string; cls: FailureClass } {
  const type = failureType(f);
  return { type, cls: CLASS[type] ?? "UNKNOWN" };
}
