// Incident runner: plays every scenario in the Airwallex sandbox twice — with our agent and with a naive one — and
// prints the scorecard. Sandbox only, test money only.
//
// Usage: node scripts/sim.ts [S1,S5,...] [--model]
//   --model  our agent reads the supplier's messages and words its replies with Claude (OPENROUTER_API_KEY or
//            ANTHROPIC_API_KEY in .env; spend is capped by LLM_BUDGET_USD, default $20, see runs/llm-spend.json)

import { mkdirSync, writeFileSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client.ts";
import { modelFromEnv } from "../src/agent/model.ts";
import { loadEnv } from "../src/env.ts";
import { NaiveAgent, OurAgent, type Agent, type Invoice } from "../src/sim/agents.ts";
import { runScenario, scenarios, type Ctx, type Result } from "../src/sim/scenarios.ts";

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"))?.split(",");
const env = loadEnv();
const model = args.includes("--model") ? modelFromEnv(env) : null;
if (args.includes("--model") && !model) throw new Error("--model: no OPENROUTER_API_KEY or ANTHROPIC_API_KEY in .env");
const spentBefore = model?.meter.spent() ?? 0;
const api = new AirwallexClient({ clientId: env.AIRWALLEX_CLIENT_ID, apiKey: env.AIRWALLEX_API_KEY });
const runId = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(2, 14);

const ben = await api.createBeneficiary({
  nickname: `HIC sim supplier ${runId}`,
  transfer_methods: ["LOCAL"],
  beneficiary: {
    type: "BANK_ACCOUNT", entity_type: "COMPANY", company_name: "Honest Test Supplies LLC",
    address: { country_code: "US", state: "NY", city: "New York", street_address: "100 Test Street", postcode: "10001" },
    bank_details: {
      bank_country_code: "US", account_currency: "USD", account_name: "Honest Test Supplies LLC",
      account_number: "123456789", bank_account_category: "Checking", account_routing_type1: "aba",
      account_routing_value1: "021000021", local_clearing_system: "ACH",
    },
  },
});
if (!ben.data?.id) throw new Error(`beneficiary: HTTP ${ben.status} ${ben.data?.code ?? ""}`);
const ctx: Ctx = { api, beneficiaryId: ben.data.id, runId };

const results: Result[] = [];
const errors: { scenario: string; agent: string; error: string }[] = [];
const makers: [string, () => Agent][] = [["ours", () => new OurAgent(api, model)], ["naive", () => new NaiveAgent(api)]];
for (const sc of scenarios.filter((s) => !only || only.includes(s.id))) {
  for (const [name, make] of makers) {
    const agent = make();
    const inv: Invoice = {
      key: `${sc.id}-${name}`,
      requestId: `hic-sim-${runId}-${sc.id}-${name[0]}`,
      transferId: null,
      beneficiaryId: ctx.beneficiaryId,
      amount: 10,
      reference: `INV ${sc.id}${name[0].toUpperCase()}`,
    };
    try {
      let r: Result;
      try {
        r = await runScenario(ctx, sc, agent, inv);
      } catch (err) {
        console.log(`${sc.id} ${name.padEnd(5)} ERROR ${(err as Error).message.slice(0, 200)}`);
        errors.push({ scenario: sc.id, agent: name, error: (err as Error).message });
        continue;
      }
      results.push(r);
      const acts = r.replies.map((x) => x.action + (x.falseClaims.length ? `(false: ${x.falseClaims.join("+")})` : "")).join(" → ");
      console.log(`${sc.id} ${name.padEnd(5)} ${r.correct ? "ok   " : "WRONG"} paid ${r.paid}, created ${r.created} | ${acts}`);
      for (const x of r.replies.filter((x) => x.text && x.model)) {
        const m = x.model!;
        console.log(`      [${m.source}${m.refused ? `, ${m.refused} draft(s) refused by the checker` : ""}${m.newBankDetails ? ", new bank details seen" : ""}${m.instructions ? `, ${m.instructions} instruction(s) in the message ignored` : ""}] ${x.text.replace(/\s+/g, " ").slice(0, 220)}`);
      }
    } finally {
      agent.close();
    }
  }
}

const sum = (agent: string, f: (r: Result) => number) => results.filter((r) => r.agent === agent).reduce((n, r) => n + f(r), 0);
const total = (agent: string) => ({
  correct: `${sum(agent, (r) => (r.correct ? 1 : 0))}/${results.filter((r) => r.agent === agent).length}`,
  doublePayments: sum(agent, (r) => (r.doublePayment ? 1 : 0)),
  falseClaims: sum(agent, (r) => r.falseClaims),
  blindResends: sum(agent, (r) => r.blindResends),
});
const t = { ours: total("ours"), naive: total("naive") };
const ourReplies = results.filter((r) => r.agent === "ours").flatMap((r) => r.replies).filter((x) => x.model);
const drafts = {
  model: ourReplies.filter((x) => x.model!.source === "model").length,
  template: ourReplies.filter((x) => x.model!.source === "template").length,
  refused: ourReplies.reduce((n, x) => n + x.model!.refused, 0),
};

const rows = scenarios
  .filter((s) => results.some((r) => r.scenario === s.id))
  .map((s) => {
    const cell = (agent: string) => {
      const r = results.find((x) => x.scenario === s.id && x.agent === agent);
      if (!r) return "— run error";
      const notes = [r.doublePayment ? "double payment" : "", r.falseClaims ? `${r.falseClaims} false claim(s)` : "", r.blindResends ? "blind re-send" : ""].filter(Boolean);
      return `${r.correct ? "✓" : "✗"} ${r.replies.map((x) => x.action).join(" → ")}${notes.length ? ` — ${notes.join(", ")}` : ""}`;
    };
    return `| ${s.id} | ${s.title} | ${s.expected} | ${cell("ours")} | ${cell("naive")} |`;
  });
const md = [
  `Airwallex sandbox, run ${runId}: each scenario played with fresh transfers, once per agent.`,
  "",
  "| | Scenario | Expected | Ours | Naive |",
  "|---|---|---|---|---|",
  ...rows,
  "",
  "| | Ours | Naive |",
  "|---|---|---|",
  `| Correct | ${t.ours.correct} | ${t.naive.correct} |`,
  `| Double payments | ${t.ours.doublePayments} | ${t.naive.doublePayments} |`,
  `| False claims to the supplier | ${t.ours.falseClaims} | ${t.naive.falseClaims} |`,
  `| Re-sends policy forbids (bad bank details, a recall) | ${t.ours.blindResends} | ${t.naive.blindResends} |`,
  ...(errors.length ? ["", `Run errors (not scored): ${errors.map((e) => `${e.scenario} ${e.agent}: ${e.error.slice(0, 120)}`).join("; ")}`] : []),
  ...(model ? ["", `Our agent's replies: ${drafts.model} worded by ${model.model}, ${drafts.template} from templates; ${drafts.refused} model draft(s) refused by the claim checker. Model spend this run: $${(model.meter.spent() - spentBefore).toFixed(4)}.`] : []),
].join("\n");

console.log("\n" + md);
mkdirSync("runs", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`runs/scorecard-${stamp}.json`, JSON.stringify({ runId, totals: t, results, errors }, null, 2));
writeFileSync(`runs/scorecard-${stamp}.md`, md + "\n");
console.log(`\nlog: runs/scorecard-${stamp}.json`);
