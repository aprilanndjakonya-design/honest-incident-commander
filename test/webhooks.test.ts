import assert from "node:assert/strict";
import { test } from "node:test";
import { sign, startReceiver, verifySignature } from "../src/airwallex/webhooks.ts";
import { Store } from "../src/ledger/store.ts";
import { fx } from "./helpers.ts";

const SECRET = "whsec_test";
const TS = "1759836892000";
// The envelope the sandbox delivers: id, name, account_id, data (the transfer), created_at, version.
const paid = {
  id: "evt-1",
  name: "payout.transfer.paid",
  account_id: "acct_test",
  data: fx.transfers.A[2],
  created_at: fx.transfers.A[2].updated_at,
  version: "2026-08-21",
};

const post = async (port: number, path: string, body: string, headers: Record<string, string>) =>
  (await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers })).status;

test("signature: hex HMAC-SHA256 of x-timestamp + raw body", () => {
  const raw = JSON.stringify(paid);
  const sig = sign(SECRET, TS, raw);
  assert.equal(verifySignature(SECRET, TS, raw, sig), true);
  assert.equal(verifySignature(SECRET, "1759836892001", raw, sig), false);
  assert.equal(verifySignature(SECRET, TS, raw + " ", sig), false);
  assert.equal(verifySignature("", TS, raw, sig), false);
  assert.equal(verifySignature(SECRET, undefined, raw, sig), false);
});

test("the receiver stores a signed event once and refuses anything unsigned", async () => {
  const store = new Store();
  const duplicates: boolean[] = [];
  const r = await startReceiver({ store, secret: () => SECRET, path: "/hook", onDelivery: (d) => duplicates.push(d.duplicate) });
  try {
    const raw = JSON.stringify(paid);
    const headers = { "content-type": "application/json", "x-timestamp": TS, "x-signature": sign(SECRET, TS, raw) };
    assert.equal(await post(r.port, "/hook", raw, headers), 200);
    assert.equal(await post(r.port, "/hook", raw, headers), 200); // a redelivery
    assert.deepEqual(duplicates, [false, true]);
    assert.equal(store.evidence(paid.data.id).length, 1);

    assert.equal(await post(r.port, "/hook", raw, { ...headers, "x-signature": "0".repeat(64) }), 401);
    const forged = JSON.stringify({ ...paid, id: "evt-2", data: { ...paid.data, status: "FAILED" } });
    assert.equal(await post(r.port, "/hook", forged, headers), 401); // the signature belongs to another body
    assert.equal(await post(r.port, "/elsewhere", raw, headers), 404);
    assert.equal(store.evidence().length, 1);
  } finally {
    await r.close();
    store.close();
  }
});
