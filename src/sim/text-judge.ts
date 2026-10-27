// Reads the claims a reply's free text makes, for the scorecard. A regex lexicon is fine as a guard inside our own
// agent (a false alarm only costs a redraft), but too crude to score other agents' prose: it flagged "we paid the
// transfer fee" and "once it is confirmed paid". So the scorecard asks a model to quote each statement of fact about
// the payment, and code compares the kinds with the sandbox truth. The same judge reads every agent's text.

import type { Model } from "../agent/model.ts";

export interface TextClaim {
  kind: "paid" | "in_transit" | "failed" | "refunded" | "replaced";
  quote: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["paid", "in_transit", "failed", "refunded", "replaced"] },
          quote: { type: "string" },
        },
        required: ["kind", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

const SYSTEM = `You audit an email that a company's accounts-payable team sent to a supplier about one invoice payment.
List every statement the email makes as a fact about where the payment stands now, or about an action already taken,
with a short exact quote. Kinds:
- paid: the invoice payment was paid or completed, or the money reached the supplier;
- in_transit: a payment is still on its way or being processed and has not arrived yet (a bare "has been sent"
  is not this kind);
- failed: a payment failed, was rejected, returned or cancelled;
- refunded: money from a failed payment came back to the company;
- replaced: a new or replacement payment has already been sent or created.
Leave out: negated statements ("has not been paid", "nothing was paid"); plans, promises and conditions ("we will
pay", "once it is paid"); statements about fees ("we paid the transfer fee"); and statements about an earlier moment
that the email itself corrects ("it showed as paid then, but it has since been returned"). Output only what the email
asserts; do not judge whether it is true.`;

export async function textClaims(model: Model, text: string): Promise<TextClaim[]> {
  if (!text.trim()) return [];
  const r = await model.json<{ claims: TextClaim[] }>({
    purpose: "judge",
    system: SYSTEM,
    user: `<email>\n${text}\n</email>`,
    schema: SCHEMA,
    effort: "low",
  });
  return r.claims;
}
