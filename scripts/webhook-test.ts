// Webhook check for Honest Incident Commander (Airwallex SANDBOX only).
//
// Starts a local receiver, subscribes it to payout.transfer.* events through the Webhooks API, runs three transfers
// (A: paid; B: fails after SENT; C: paid, then returned) and records every delivery: event name, event id, arrival
// time and whether the signature verifies. The first delivery of A's "paid" event is answered with HTTP 500 to see
// whether and when Airwallex retries. The subscription is deleted at the end.
//
// The receiver must be reachable from the internet, e.g. through a temporary tunnel:
//   cloudflared tunnel --url http://localhost:8787
// Usage: WEBHOOK_PUBLIC_URL=https://<tunnel host> node scripts/webhook-test.ts [waitSeconds]

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const BASE = "https://api.sandbox.airwallex.com";
const API_VERSION = "2026-08-21";
const PORT = 8787;
const HOOK_PATH = `/airwallex/webhook/${randomUUID()}`;
const EVENTS = [
  "payout.transfer.scheduled", "payout.transfer.processing", "payout.transfer.sent", "payout.transfer.paid",
  "payout.transfer.failed", "payout.transfer.cancelled", "payout.transfer.overdue",
  "payout.transfer.cancellation_requested",
];

type Json = any;
interface Delivery {
  ms: number; eventId: string; name: string; transferId: string; status: string; createdAt: string;
  signature: "ok" | "mismatch" | "missing"; answered: number;
}
interface Mark { ms: number; transfer: string; action: string; http: number }

const t0 = Date.now();
const since = () => Date.now() - t0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deliveries: Delivery[] = [];
const marks: Mark[] = [];
let token = "";
let secret = "";
let failFirstPaidFor = "";
const seenIds = new Set<string>();

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

async function api(method: string, path: string, body?: Json, headers: Record<string, string> = {}) {
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
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

const errText = (r: { status: number; data: Json }) => `HTTP ${r.status} ${r.data?.code ?? ""} ${r.data?.message ?? ""}`.trim();

// Signature: HMAC-SHA256 over x-timestamp + raw body, hex-encoded, keyed with the webhook secret.
function verify(ts: string | undefined, sig: string | undefined, raw: string): Delivery["signature"] {
  if (!ts || !sig || !secret) return "missing";
  const expected = createHmac("sha256", secret).update(ts + raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "mismatch";
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== HOOK_PATH) { res.writeHead(404).end(); return; }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let ev: Json = {};
    try { ev = JSON.parse(raw); } catch { /* keep empty */ }
    if (ev.selftest) { res.writeHead(200).end("ok"); return; }
    const obj = ev.data?.object ?? ev.data ?? {};
    const eventId = String(ev.id ?? "");
    const name = String(ev.name ?? ev.type ?? "");
    const transferId = String(obj.id ?? "");
    // Ответить 500 на первую доставку «paid» по переводу A — проверка повторной доставки.
    const answered = name.endsWith(".paid") && transferId === failFirstPaidFor && !seenIds.has(eventId) ? 500 : 200;
    seenIds.add(eventId);
    deliveries.push({
      ms: since(), eventId, name, transferId, status: String(obj.status ?? ""), createdAt: String(ev.created_at ?? ""),
      signature: verify(req.headers["x-timestamp"] as string, req.headers["x-signature"] as string, raw), answered,
    });
    res.writeHead(answered, { "content-type": "application/json" }).end("{}");
  });
});

async function status(id: string) {
  return (await api("GET", `/api/v1/transfers/${id}`)).data?.status as string;
}

// Drive along SCHEDULED → PROCESSING → SENT → PAID; the sandbox moves SCHEDULED → PROCESSING by itself.
async function driveTo(tag: string, id: string, target: string) {
  const chain = ["SCHEDULED", "PROCESSING", "SENT", "PAID"];
  let st = await status(id);
  while (chain.indexOf(st) >= 0 && chain.indexOf(st) < chain.indexOf(target)) {
    await transition(tag, id, chain[chain.indexOf(st) + 1]);
    const now = await status(id);
    if (chain.indexOf(now) <= chain.indexOf(st)) return now;
    st = now;
  }
  return st;
}

async function transition(tag: string, id: string, next_status: string, failure_type?: string) {
  const r = await api("POST", `/api/v1/simulation/transfers/${id}/transition`,
    failure_type ? { next_status, failure_type } : { next_status });
  marks.push({ ms: since(), transfer: tag, action: next_status + (failure_type ? `(${failure_type})` : ""), http: r.status });
  if (r.status >= 300) console.log(`  ${tag} → ${next_status}: ${errText(r)}`);
  return r.status < 300;
}

async function main() {
  const publicUrl = (process.env.WEBHOOK_PUBLIC_URL || "").replace(/\/$/, "");
  const waitSeconds = Number(process.argv[2] || 150);
  if (!publicUrl.startsWith("https://")) throw new Error("set WEBHOOK_PUBLIC_URL to the tunnel's https URL");
  const env = loadEnv(".env");
  const runId = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  const self = await fetch(publicUrl + HOOK_PATH, { method: "POST", body: JSON.stringify({ selftest: true }) }).catch((e) => e);
  console.log(`receiver: ${self?.status === 200 ? "reachable through the tunnel" : "NOT reachable: " + (self?.status ?? self)}`);
  if (self?.status !== 200) return;

  const login = await api("POST", "/api/v1/authentication/login", undefined,
    { "x-client-id": env.AIRWALLEX_CLIENT_ID, "x-api-key": env.AIRWALLEX_API_KEY });
  if (!login.data?.token) { console.log("login: " + errText(login)); return; }
  token = login.data.token;

  const hook = await api("POST", "/api/v1/webhooks/create",
    { url: publicUrl + HOOK_PATH, version: API_VERSION, events: EVENTS, request_id: `hic-wh-${runId}` });
  if (hook.status >= 300) { console.log("create webhook: " + errText(hook) + " " + JSON.stringify(hook.data?.details ?? "")); return; }
  secret = hook.data.secret ?? "";
  const hookId = hook.data.id;
  console.log(`webhook ${hookId} subscribed to ${hook.data.events?.length} events (secret received: ${secret ? "yes" : "no"})`);

  try {
    const ben = await api("POST", "/api/v1/beneficiaries/create", {
      nickname: `HIC webhook supplier ${runId}`,
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
    if (!ben.data?.id) { console.log("beneficiary: " + errText(ben)); return; }

    const ids: Record<string, string> = {};
    for (const tag of ["A", "B", "C"]) {
      const r = await api("POST", "/api/v1/transfers/create", {
        beneficiary_id: ben.data.id, request_id: `hic-wh-${runId}-${tag}`, source_currency: "USD", transfer_currency: "USD",
        transfer_amount: "10.00", transfer_method: "LOCAL", reason: "goods_purchased", reference: `HIC WEBHOOK ${tag}`,
      });
      if (!r.data?.id) { console.log(`transfer ${tag}: ${errText(r)}`); return; }
      ids[tag] = r.data.id;
      marks.push({ ms: since(), transfer: tag, action: "create", http: r.status });
    }
    failFirstPaidFor = ids.A;

    await driveTo("A", ids.A, "PAID");
    await driveTo("B", ids.B, "SENT");
    await transition("B", ids.B, "FAILED", "ACCOUNT_CLOSED");
    await driveTo("C", ids.C, "PAID");
    await transition("C", ids.C, "FAILED", "BENEFICIARY_BANK_RETURNED");
    console.log(`transitions done at +${Math.round(since() / 1000)} s; waiting ${waitSeconds} s for deliveries`);

    for (let waited = 0; waited < waitSeconds; waited += 15) {
      await sleep(15000);
      console.log(`  +${Math.round(since() / 1000)} s: ${deliveries.length} deliveries`);
    }

    // Разбор: по каждому переводу — какие события пришли, в каком порядке, были ли повторы.
    const byTag = (tag: string) => deliveries.filter((d) => d.transferId === ids[tag]);
    console.log("");
    for (const tag of ["A", "B", "C"]) {
      const ds = byTag(tag);
      const line = ds.map((d) => `${d.name.replace("payout.transfer.", "")}${d.answered === 500 ? "[500]" : ""}@${(d.ms / 1000).toFixed(1)}s`).join(", ");
      const ids2 = ds.map((d) => d.eventId);
      const dups = ids2.length - new Set(ids2).size;
      const firsts = ds.filter((d, i) => ids2.indexOf(d.eventId) === i);
      const outOfOrder = firsts.some((d, i) => i > 0 && d.createdAt < firsts[i - 1].createdAt);
      console.log(`${tag}: ${ds.length} deliveries, ${dups} repeated event ids, ${outOfOrder ? "OUT OF ORDER" : "in created_at order"} — ${line || "none"}`);
    }
    const failedSeen = ["B", "C"].map((t) => `${t}: ${byTag(t).some((d) => d.name.endsWith(".failed")) ? "failed event delivered" : "NO failed event"}`);
    console.log(failedSeen.join("; "));
    const paidA = byTag("A").filter((d) => d.name.endsWith(".paid"));
    if (paidA.length) {
      const retry = paidA.length > 1 ? `retried after ${((paidA[1].ms - paidA[0].ms) / 1000).toFixed(1)} s` : `no retry within ${waitSeconds} s`;
      console.log(`A paid answered 500 first: ${retry}`);
    }
    const sig = deliveries.reduce((m: Record<string, number>, d) => ((m[d.signature] = (m[d.signature] ?? 0) + 1), m), {});
    console.log(`signatures: ${JSON.stringify(sig)}; other events: ${deliveries.filter((d) => !Object.values(ids).includes(d.transferId)).length}`);
  } finally {
    const del = await api("POST", `/api/v1/webhooks/${hookId}/delete`);
    console.log(`webhook deleted: ${del.status < 300 ? "yes" : errText(del)}`);
  }
}

try {
  await main();
} catch (e) {
  console.log("error: " + String(e));
  process.exitCode = 1;
} finally {
  server.close();
  mkdirSync("runs", { recursive: true });
  const file = `runs/webhooks-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ api_version: API_VERSION, events: EVENTS, marks, deliveries }, null, 2));
  console.log(`log: ${file}`);
}
