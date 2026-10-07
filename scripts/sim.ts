// Incident runner: plays every scenario in the Airwallex sandbox twice — with our agent and with a naive one — and
// prints the scorecard. Sandbox only, test money only.
//
// Usage: node scripts/sim.ts [S1,S5,...]

import { mkdirSync, writeFileSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client.ts";
import { loadEnv } from "../src/env.ts";
import { NaiveAgent, OurAgent, type Agent, type Invoice } from "../src/sim/agents.ts";
import { runScenario, scenarios, type Ctx, type Result } from "../src/sim/scenarios.ts";

const only = process.argv[2]?.split(",");
const env = loadEnv();
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
const makers: [string, () => Agent][] = [["ours", () => new OurAgent(api)], ["naive", () => new NaiveAgent(api)]];
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
      const r = await runScenario(ctx, sc, agent, inv);
      results.push(r);
      const acts = r.replies.map((x) => x.action + (x.falseClaims.length ? `(false: ${x.falseClaims.join("+")})` : "")).join(" → ");
      console.log(`${sc.id} ${name.padEnd(5)} ${r.correct ? "ok   " : "WRONG"} paid ${r.paid}, created ${r.created} | ${acts}`);
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

const rows = scenarios
  .filter((s) => results.some((r) => r.scenario === s.id))
  .map((s) => {
    const cell = (agent: string) => {
      const r = results.find((x) => x.scenario === s.id && x.agent === agent)!;
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
  `| Blind re-sends to bad bank details | ${t.ours.blindResends} | ${t.naive.blindResends} |`,
].join("\n");

console.log("\n" + md);
mkdirSync("runs", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`runs/scorecard-${stamp}.json`, JSON.stringify({ runId, totals: t, results }, null, 2));
writeFileSync(`runs/scorecard-${stamp}.md`, md + "\n");
console.log(`\nlog: runs/scorecard-${stamp}.json`);
