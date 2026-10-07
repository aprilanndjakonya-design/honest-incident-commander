import assert from "node:assert/strict";
import { test } from "node:test";
import { AirwallexClient, endpointOf, OutcomeUnknownError, Pacer } from "../src/airwallex/client.ts";

const KEY = "test-api-key-that-must-never-leak";
const instant = () => new Pacer({ perEndpointMs: 0, globalMs: 0 });
type Route = () => { status: number; body: unknown };

// A fake Airwallex that answers by "METHOD path-prefix" and records every call.
function fake(routes: Record<string, Route | (() => never)>) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = `${init?.method} ${String(url).replace(/^https?:\/\/[^/]+/, "")}`;
    calls.push(call);
    const hit = Object.entries(routes).find(([prefix]) => call.startsWith(prefix));
    if (!hit) return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    const r = hit[1]();
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls, logins: () => calls.filter((c) => c.includes("/authentication/login")).length };
}
const login = (expires = "2099-01-01T00:00:00+0000"): Route => () => ({ status: 201, body: { token: "tok", expires_at: expires } });

test("one login while the token is fresh, a new one a minute before it expires", async () => {
  let now = Date.parse("2026-10-07T12:00:00Z");
  const api = fake({ "POST /api/v1/authentication/login": login("2026-10-07T12:30:00+0000"), "GET /api/v1/transfers/": () => ({ status: 200, body: {} }) });
  const c = new AirwallexClient({ clientId: "id", apiKey: KEY, fetch: api.f, pacer: instant(), now: () => now });
  for (let i = 0; i < 3; i++) await c.getTransfer("t1");
  assert.equal(api.logins(), 1);
  now = Date.parse("2026-10-07T12:29:30Z");
  await c.getTransfer("t1");
  assert.equal(api.logins(), 2);
});

test("a 401 renews the token and retries once", async () => {
  let first = true;
  const api = fake({
    "POST /api/v1/authentication/login": login(),
    "GET /api/v1/transfers/": () => (first ? ((first = false), { status: 401, body: {} }) : { status: 200, body: { id: "t1" } }),
  });
  const c = new AirwallexClient({ clientId: "id", apiKey: KEY, fetch: api.f, pacer: instant() });
  assert.equal((await c.getTransfer("t1")).status, 200);
  assert.equal(api.logins(), 2);
});

test("a create with no answer, or a 5xx, is an unknown outcome carrying the request_id — never the key", async () => {
  for (const route of [
    (): never => { throw new DOMException("The operation timed out", "TimeoutError"); },
    () => ({ status: 503, body: { code: "unavailable" } }),
  ]) {
    const api = fake({ "POST /api/v1/authentication/login": login(), "POST /api/v1/transfers/create": route });
    const c = new AirwallexClient({ clientId: "id", apiKey: KEY, fetch: api.f, pacer: instant() });
    await assert.rejects(c.createTransfer({ request_id: "rid-1" }), (err: unknown) => {
      assert.ok(err instanceof OutcomeUnknownError);
      assert.equal(err.requestId, "rid-1");
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  }
});

test("a 4xx on create is an answer, not an unknown outcome", async () => {
  const dup = { code: "duplicate_request_id", details: { id: "t1", request_id: "rid-1" } };
  const api = fake({ "POST /api/v1/authentication/login": login(), "POST /api/v1/transfers/create": () => ({ status: 400, body: dup }) });
  const c = new AirwallexClient({ clientId: "id", apiKey: KEY, fetch: api.f, pacer: instant() });
  assert.deepEqual(await c.createTransfer({ request_id: "rid-1" }), { status: 400, data: dup });
});

test("a refused login is an ordinary error and does not echo the key", async () => {
  const api = fake({ "POST /api/v1/authentication/login": () => ({ status: 401, body: { code: "credentials_invalid" } }) });
  const c = new AirwallexClient({ clientId: "id", apiKey: KEY, fetch: api.f, pacer: instant() });
  await assert.rejects(c.createTransfer({ request_id: "rid-1" }), (err: unknown) => {
    assert.ok(err instanceof Error && !(err instanceof OutcomeUnknownError));
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  assert.equal(api.calls.filter((x) => x.includes("/transfers/create")).length, 0);
});

test("findByRequestId: an error is not 'not found'", async () => {
  let status = 500;
  const api = fake({ "POST /api/v1/authentication/login": login(), "GET /api/v1/transfers?request_id=": () => ({ status, body: { items: [] } }) });
  const c = new AirwallexClient({ clientId: "id", apiKey: KEY, fetch: api.f, pacer: instant() });
  await assert.rejects(c.findByRequestId("rid-1"));
  status = 200;
  assert.equal(await c.findByRequestId("rid-1"), null);
});

test("the pacer spaces calls per endpoint and overall", async () => {
  let t = 0;
  const slept: number[] = [];
  const p = new Pacer({ perEndpointMs: 110, globalMs: 55, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await p.wait("GET /a");
  await p.wait("GET /a");
  await p.wait("GET /b");
  assert.deepEqual(slept, [110, 55]);
});

test("endpoints are grouped by path template", () => {
  const id = "0c395b6a-791c-4d39-a97b-7b37daf2ce8e";
  assert.equal(endpointOf("GET", `/api/v1/transfers/${id}`), "GET /api/v1/transfers/:id");
  assert.equal(endpointOf("POST", `/api/v1/simulation/transfers/${id}/transition`), "POST /api/v1/simulation/transfers/:id/transition");
  assert.equal(endpointOf("GET", "/api/v1/transfers?request_id=x"), "GET /api/v1/transfers");
});
