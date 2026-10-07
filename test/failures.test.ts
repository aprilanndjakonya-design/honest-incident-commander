import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, SANDBOX_FAILURE_CODES } from "../src/payments/failures.ts";

// Every code the sandbox returned lands in the class we intend; details.type (always INCORRECT_ROUTING there) is ignored.
const EXPECTED: Record<string, string> = {
  "90101": "DETAILS", "90301": "DETAILS", "90302": "DETAILS", "90701": "DETAILS", "90702": "DETAILS", "90802": "DETAILS",
  "91402": "RETRY",
  "90501": "STOP", "90703": "STOP", "90801": "STOP", "91001": "STOP", "91002": "STOP", "91201": "STOP", "91301": "STOP",
  "99902": "UNKNOWN",
};

test("every sandbox failure code has an intended class", () => {
  assert.deepEqual(Object.keys(SANDBOX_FAILURE_CODES).sort(), Object.keys(EXPECTED).sort());
  for (const [code, cls] of Object.entries(EXPECTED)) {
    assert.equal(classify({ code, message: "", details: { type: "INCORRECT_ROUTING" } }).cls, cls, code);
  }
});

test("an unknown code falls back to the message, then to details.type, then fails closed", () => {
  assert.equal(classify({ code: "12345", message: "Channel timeout" }).type, "CHANNEL_TIMEOUT");
  assert.equal(classify({ code: "12345", message: "?", details: { type: "ACCOUNT_CLOSED" } }).cls, "DETAILS");
  assert.equal(classify({ code: "12345", message: "?" }).cls, "UNKNOWN");
  assert.equal(classify(null).cls, "UNKNOWN");
});
