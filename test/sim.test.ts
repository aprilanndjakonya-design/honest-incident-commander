import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeModel } from "../src/agent/model.ts";
import type { AirwallexClient } from "../src/airwallex/client.ts";
import { classify, SANDBOX_FAILURE_CODES } from "../src/payments/failures.ts";
import { parseSimArgs } from "../src/sim/args.ts";
import { ClaudeAloneAgent, POLICY } from "../src/sim/claude-alone.ts";

test("sim args: an option's value is never the scenario filter", () => {
  // The bug of 27 Oct: "S12 --agents claude-policy" played all sixteen scenarios.
  assert.deepEqual(parseSimArgs(["S12", "--agents", "claude-policy"]).only, ["S12"]);
  assert.deepEqual(parseSimArgs(["--agents", "ours", "S1,S5"]).only, ["S1", "S5"]);
  assert.equal(parseSimArgs(["--agents", "ours"]).only, null);
  const a = parseSimArgs(["--model", "--ours-model", "anthropic/claude-sonnet-5.5", "--agents", "ours,claude-policy"]);
  assert.equal(a.only, null);
  assert.deepEqual(a.agents, ["ours", "claude-policy"]);
  assert.equal(a.oursModel, "anthropic/claude-sonnet-5.5");
  assert.equal(a.model, true);
  assert.deepEqual(parseSimArgs([]), { only: null, agents: ["ours", "naive"], model: false, oursModel: null });
});

test("sim args: a missing value, an unknown option or two filters stop the run", () => {
  assert.throws(() => parseSimArgs(["--agents"]), /needs a value/);
  assert.throws(() => parseSimArgs(["--ours-model", "--model"]), /needs a value/);
  assert.throws(() => parseSimArgs(["--agent", "ours"]), /unknown option/);
  assert.throws(() => parseSimArgs(["S1", "S2"]), /one scenario list/);
});

test("claude-policy is the same agent with our decision table appended to its prompt", () => {
  const api = {} as AirwallexClient;
  const model = {} as ClaudeModel;
  const plain = new ClaudeAloneAgent(api, model);
  const withPolicy = new ClaudeAloneAgent(api, model, { policy: true });
  assert.equal(plain.name, "claude");
  assert.equal(withPolicy.name, "claude-policy");
  assert.ok(!plain.system.includes("Our payment policy"));
  assert.equal(withPolicy.system, plain.system + POLICY);
});

test("the policy prompt puts every sandbox failure code in the class the code gives it", () => {
  // Keeps the prose in step with src/payments/failures.ts: a code moved there must move in the prompt too.
  const bullet = (start: string, end: string) => POLICY.slice(POLICY.indexOf(start), POLICY.indexOf(end));
  const sections = {
    DETAILS: bullet("Bank details wrong or stale", "A transient channel problem"),
    RETRY: bullet("A transient channel problem", "Requested, restricted or duplicate"),
    STOP: bullet("Requested, restricted or duplicate", "Anything else"),
  };
  for (const [code] of Object.entries(SANDBOX_FAILURE_CODES)) {
    const { cls } = classify({ code, message: "", details: { type: "INCORRECT_ROUTING" } } as never);
    if (cls === "UNKNOWN") {
      for (const text of Object.values(sections)) assert.ok(!text.includes(code), `${code} is UNKNOWN in code but named in the prompt`);
      continue;
    }
    assert.ok(sections[cls].includes(code), `${code} (${cls}) missing from the ${cls} bullet of the policy prompt`);
  }
});
