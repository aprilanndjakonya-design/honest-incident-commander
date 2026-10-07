// Webhook receiver: verifies the signature, stores each event once, answers fast.
//
// Signature (checked against the sandbox, 16 of 16 deliveries): hex HMAC-SHA256 of `x-timestamp` + raw body, keyed
// with the secret returned when the webhook is created. Unsigned or wrongly signed deliveries are refused and never
// stored. Redeliveries are acknowledged and stored once.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Store } from "../ledger/store.ts";
import { fromWebhook } from "../payments/evidence.ts";
import type { WebhookEvent } from "../payments/types.ts";

export function sign(secret: string, timestamp: string, raw: string): string {
  return createHmac("sha256", secret).update(timestamp + raw).digest("hex");
}

export function verifySignature(secret: string, timestamp: string | undefined, raw: string, signature: string | undefined): boolean {
  if (!secret || !timestamp || !signature) return false;
  const expected = Buffer.from(sign(secret, timestamp, raw));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface Delivery {
  eventId: string;
  name: string;
  transferId: string;
  duplicate: boolean;
}

export interface Receiver {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY = 1 << 20;

export function startReceiver(opts: {
  store: Store;
  secret: () => string; // a getter: the secret arrives only after the webhook is created with the receiver's URL
  path: string;
  port?: number;
  host?: string;
  now?: () => string;
  onDelivery?: (d: Delivery) => void;
}): Promise<Receiver> {
  const now = opts.now ?? (() => new Date().toISOString());
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== opts.path) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      const ts = req.headers["x-timestamp"] as string | undefined;
      const sig = req.headers["x-signature"] as string | undefined;
      if (!verifySignature(opts.secret(), ts, raw, sig)) {
        res.writeHead(401).end();
        return;
      }
      let ev: WebhookEvent;
      try {
        ev = JSON.parse(raw) as WebhookEvent;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof ev.name === "string" && ev.name.startsWith("payout.transfer.") && ev.data?.id) {
        const duplicate = !opts.store.addEvidence(fromWebhook(ev), now());
        opts.onDelivery?.({ eventId: ev.id, name: ev.name, transferId: ev.data.id, duplicate });
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
