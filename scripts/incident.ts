// Investigate one incident in the Airwallex sandbox: gather the evidence into the local record, decide, and print the
// decision with what it cites. Read-only towards Airwallex: it never creates or replaces a transfer.
//
// Usage: node scripts/incident.ts --transfer <transfer id> [--amount 10] [--db hic.sqlite]
//        node scripts/incident.ts --request-id <request_id> [--amount 10]

import { parseArgs } from "node:util";
import { AirwallexClient } from "../src/airwallex/client.ts";
import { loadEnv } from "../src/env.ts";
import { investigate } from "../src/incident.ts";
import { Store } from "../src/ledger/store.ts";

const { values } = parseArgs({
  options: {
    transfer: { type: "string" },
    "request-id": { type: "string" },
    amount: { type: "string", default: "10" },
    db: { type: "string", default: "hic.sqlite" },
  },
});
if (!values.transfer && !values["request-id"]) {
  console.error("usage: node scripts/incident.ts --transfer <id> | --request-id <request_id> [--amount 10]");
  process.exit(2);
}

const env = loadEnv();
const client = new AirwallexClient({ clientId: env.AIRWALLEX_CLIENT_ID, apiKey: env.AIRWALLEX_API_KEY });
const store = new Store(values.db);
try {
  const r = await investigate({
    api: client,
    store,
    transferId: values.transfer,
    requestId: values["request-id"],
    amount: Number(values.amount),
  });
  const t = r.transfer;
  const hm = (iso: string) => iso.slice(11, 19);
  if (t) {
    console.log(`Transfer ${t.id} (${t.request_id}, ${t.short_reference_id ?? "-"}) — ${t.transfer_amount} ${t.transfer_currency}`);
    console.log(`History: ${r.view!.history.map((h) => `${h.status} ${hm(h.at)}`).join(" → ")}`);
    const l = r.view!.ledger;
    console.log(`Ledger: paid out ${l.paidOut}, fee ${l.fees}, reversed ${l.reversed}`);
    if (r.view!.failure) console.log(`Failure: ${r.view!.failure.code} "${r.view!.failure.message}"`);
  } else {
    console.log(`No transfer found for ${values.transfer ?? values["request-id"]}`);
  }
  if (r.replacement) console.log(`Replacement: ${r.replacement.requestId} → ${r.replacement.view?.status ?? "not found"}`);
  console.log(`Decision: ${r.decision.action}`);
  console.log(`  ${r.decision.reason}`);
  if (r.decision.cites.length) console.log(`  cites: ${r.decision.cites.join(", ")}`);
} finally {
  store.close();
}
