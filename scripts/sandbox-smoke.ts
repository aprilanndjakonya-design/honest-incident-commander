// Sandbox smoke check for Honest Incident Commander (Airwallex starter kit 03).
//
// Proves, against the Airwallex SANDBOX only, the API behaviour the agent will rely on:
//   1. login with a scoped key, balances
//   2. a supplier beneficiary
//   3. transfer A: happy path to PAID
//   4. idempotency: the same request_id is refused and points to the existing transfer
//   5. recovery after an unknown outcome: find the transfer by request_id
//   6. transfer B: fails in transit (is FAILED visible before the auto-cancel? is the reason kept?)
//   7. transfer C: PAID, then fails later ("PAID is not always final")
//   8. ledger evidence: financial transactions for each transfer
//
// Keys come from .env (AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY) and are never printed.
// Usage: node scripts/sandbox-smoke.ts   (Node 22.18+ runs TypeScript directly)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = "https://api.sandbox.airwallex.com";
const API_VERSION = "2026-08-21";
if (BASE !== "https://api.sandbox.airwallex.com") throw new Error("sandbox only");

type Json = any;
interface Call { step: string; method: string; path: string; status: number; ms: number; request?: Json; response?: Json }
interface Check { name: string; ok: boolean; note: string }

const calls: Call[] = [];
const checks: Check[] = [];
let token = "";

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function redact(data: Json): Json {
  if (data && typeof data === "object" && "token" in data) return { ...data, token: "<redacted>" };
  return data;
}

async function api(step: string, method: string, path: string, body?: Json, headers: Record<string, string> = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-version": API_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: Json;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  calls.push({ step, method, path, status: res.status, ms: Date.now() - t0, request: body, response: redact(data) });
  return { status: res.status, data };
}

function check(name: string, ok: boolean, note = "") {
  checks.push({ name, ok, note });
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}${note ? " — " + note : ""}`);
}

function errText(r: { status: number; data: Json }) {
  const d = r.data || {};
  return `HTTP ${r.status} ${d.code ?? ""} ${d.message ?? ""} ${d.source ? "source=" + d.source : ""}`.trim();
}

async function getTransfer(id: string) {
  return (await api("get transfer", "GET", `/api/v1/transfers/${id}`)).data;
}

// Poll a transfer and record every distinct status until one of `stopOn` appears or time runs out.
async function watch(id: string, stopOn: string[], timeoutMs: number, everyMs: number) {
  const seen: string[] = [];
  let last: Json = null;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    last = await getTransfer(id);
    const st = last?.status;
    if (st && seen[seen.length - 1] !== st) seen.push(st);
    if (stopOn.includes(st)) break;
    await sleep(everyMs);
  }
  return { seen, last };
}

async function transition(id: string, next_status: string, failure_type?: string, quiet = false) {
  const body = failure_type ? { next_status, failure_type } : { next_status };
  const r = await api(`transition ${next_status}`, "POST", `/api/v1/simulation/transfers/${id}/transition`, body);
  if (r.status >= 300 && !quiet) console.log(`      transition → ${next_status}: ${errText(r)}`);
  return r;
}

// Drive a transfer along SCHEDULED → PROCESSING → SENT → PAID until it reaches `target`.
async function driveTo(id: string, target: "PROCESSING" | "SENT" | "PAID") {
  const chain = ["SCHEDULED", "PROCESSING", "SENT", "PAID"];
  let st = (await getTransfer(id))?.status;
  while (chain.indexOf(st) >= 0 && chain.indexOf(st) < chain.indexOf(target)) {
    const next = chain[chain.indexOf(st) + 1];
    const r = await transition(id, next, undefined, true);
    const now = (await getTransfer(id))?.status;
    // The sandbox moves SCHEDULED → PROCESSING by itself within ~0.3 s; a refused step is fine if the status moved on.
    if (r.status >= 300 && chain.indexOf(now) <= chain.indexOf(st)) return now;
    st = now;
  }
  return st;
}

async function main() {
  const env = loadEnv(".env");
  if (!env.AIRWALLEX_CLIENT_ID || !env.AIRWALLEX_API_KEY) {
    console.error("AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY are empty in .env");
    process.exit(2);
  }
  const runId = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  console.log(`Airwallex SANDBOX smoke, run ${runId} (test money only)\n`);

  // 1. Login and balances
  const login = await api("login", "POST", "/api/v1/authentication/login", undefined, {
    "x-client-id": env.AIRWALLEX_CLIENT_ID,
    "x-api-key": env.AIRWALLEX_API_KEY,
  });
  check("login with scoped key", login.status === 201 && !!login.data?.token,
    login.status === 201 ? `token until ${login.data?.expires_at}` : errText(login));
  if (!login.data?.token) return;
  token = login.data.token;

  const bal = await api("balances", "GET", "/api/v1/balances/current");
  const usdBefore = Array.isArray(bal.data) ? bal.data.find((b: Json) => b.currency === "USD") : null;
  check("read balances", bal.status === 200 && Array.isArray(bal.data),
    bal.status === 200 ? bal.data.filter((b: Json) => b.total_amount > 0).map((b: Json) => `${b.currency} ${b.available_amount}`).join(", ") : errText(bal));

  // 2. Supplier beneficiary (US, ACH)
  const schema = await api("beneficiary schema", "POST", "/api/v1/beneficiary_api_schemas/generate", {
    type: "BANK_ACCOUNT", entity_type: "COMPANY", bank_country_code: "US", account_currency: "USD",
    transfer_method: "LOCAL", local_clearing_system: "ACH",
  });
  check("beneficiary API schema for US/USD/ACH", schema.status === 200, schema.status === 200 ? "" : errText(schema));

  const ben = await api("create beneficiary", "POST", "/api/v1/beneficiaries/create", {
    nickname: `HIC smoke supplier ${runId}`,
    transfer_methods: ["LOCAL"],
    beneficiary: {
      type: "BANK_ACCOUNT",
      entity_type: "COMPANY",
      company_name: "Honest Test Supplies LLC",
      address: { country_code: "US", state: "NY", city: "New York", street_address: "100 Test Street", postcode: "10001" },
      bank_details: {
        bank_country_code: "US",
        account_currency: "USD",
        account_name: "Honest Test Supplies LLC",
        account_number: "123456789",
        bank_account_category: "Checking",
        account_routing_type1: "aba",
        account_routing_value1: "021000021",
        local_clearing_system: "ACH",
      },
    },
  });
  const benId = ben.data?.id || ben.data?.beneficiary_id;
  check("create supplier beneficiary", ben.status < 300 && !!benId, ben.status < 300 ? benId : errText(ben));
  if (!benId) return;

  let reason = "goods_purchased";
  async function createTransfer(tag: string, requestId?: string) {
    const rid = requestId ?? `hic-smoke-${runId}-${tag}`;
    const body = (why: string) => ({
      beneficiary_id: benId, request_id: rid, source_currency: "USD", transfer_currency: "USD",
      transfer_amount: "10.00", transfer_method: "LOCAL", reason: why, reference: `HIC SMOKE ${tag.toUpperCase()}`,
    });
    let r = await api(`create transfer ${tag}`, "POST", "/api/v1/transfers/create", body(reason));
    // If the sandbox rejects the reason value, retry once with the spec's example value and a new request_id.
    if (r.status === 400 && /reason/i.test(JSON.stringify(r.data)) && reason !== "travel" && !requestId) {
      console.log(`      reason "${reason}" rejected: ${errText(r)}; retrying with "travel"`);
      reason = "travel";
      return createTransfer(tag + "r");
    }
    return { rid, r };
  }

  // 3. Transfer A: happy path to PAID
  const a = await createTransfer("a");
  const aId = a.r.data?.id;
  check("create transfer A", a.r.status < 300 && !!aId, a.r.status < 300 ? `${aId}, status ${a.r.data?.status}` : errText(a.r));
  if (!aId) return;
  const aFinal = await driveTo(aId, "PAID");
  check("A: simulated SCHEDULED → PROCESSING → SENT → PAID", aFinal === "PAID", `final status ${aFinal}`);

  // 4. Idempotency: the same request_id must not create a second payment
  const dup = await createTransfer("a", a.rid);
  const dupText = JSON.stringify(dup.r.data);
  check("same request_id is refused (no double payment)", dup.r.status >= 400 && /duplicate/i.test(dupText),
    `${errText(dup.r)}${dupText.includes(aId) ? ", points to A" : ""}`);

  // 5. Recovery after an unknown outcome: find the transfer by request_id
  const byRid = await api("find by request_id", "GET", `/api/v1/transfers?request_id=${encodeURIComponent(a.rid)}`);
  const items = byRid.data?.items ?? byRid.data?.data ?? [];
  check("find transfer by request_id", byRid.status === 200 && items.length === 1 && items[0]?.id === aId,
    byRid.status === 200 ? `${items.length} found` : errText(byRid));

  // 6. Transfer B fails in transit. Fast polling shows whether FAILED is visible before the auto-cancel
  // and whether the reason survives. In the sandbox PROCESSING → FAILED returns HTTP 500 (probe, 7 Oct 2026),
  // so the failure is simulated from SENT.
  const b = await createTransfer("b");
  const bId = b.r.data?.id;
  check("create transfer B", b.r.status < 300 && !!bId, b.r.status < 300 ? bId : errText(b.r));
  if (bId) {
    await driveTo(bId, "SENT");
    const t = await transition(bId, "FAILED", "ACCOUNT_CLOSED");
    const w = await watch(bId, ["CANCELLED"], 20000, 250);
    check("B: SENT, then FAILED (account closed)", t.status < 300 && (w.seen.includes("FAILED") || w.seen.includes("CANCELLED")),
      `statuses seen: ${w.seen.join(" → ")}; failure: ${JSON.stringify(w.last?.failure ?? null)}`);
  }

  // 7. Transfer C: PAID, then returned by the beneficiary's bank
  const c = await createTransfer("c");
  const cId = c.r.data?.id;
  check("create transfer C", c.r.status < 300 && !!cId, c.r.status < 300 ? cId : errText(c.r));
  if (cId) {
    const cPaid = await driveTo(cId, "PAID");
    const t = await transition(cId, "FAILED", "BENEFICIARY_BANK_RETURNED");
    const w = await watch(cId, ["CANCELLED"], 20000, 250);
    check("C: PAID, then FAILED later (PAID is not final)", cPaid === "PAID" && t.status < 300,
      `statuses after PAID: ${w.seen.join(" → ")}; failure: ${JSON.stringify(w.last?.failure ?? null)}`);
  }

  // 8. Ledger evidence: what was actually debited and returned
  for (const [tag, id] of [["A", aId], ["B", bId], ["C", cId]] as const) {
    if (!id) continue;
    const ft = await api(`ledger ${tag}`, "GET", `/api/v1/financial_transactions?source_id=${id}`);
    const rows = ft.data?.items ?? [];
    check(`ledger entries for ${tag}`, ft.status === 200,
      ft.status === 200 ? (rows.map((x: Json) => `${x.transaction_type} ${x.amount} ${x.currency} ${x.status}`).join("; ") || "none yet") : errText(ft));
  }

  const balAfter = await api("balances after", "GET", "/api/v1/balances/current");
  const usdAfter = Array.isArray(balAfter.data) ? balAfter.data.find((x: Json) => x.currency === "USD") : null;
  console.log(`\nUSD available: ${usdBefore?.available_amount} → ${usdAfter?.available_amount}`);
}

try {
  await main();
} catch (e) {
  check("script finished without exception", false, String(e));
} finally {
  mkdirSync("runs", { recursive: true });
  const file = `runs/sandbox-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ base: BASE, api_version: API_VERSION, checks, calls }, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed; ${calls.length} API calls; log: ${file}`);
  process.exitCode = failed ? 1 : 0;
}
