// Airwallex REST client: one cached token, paced calls, and an explicit "outcome unknown" when a create call gets no
// answer — the caller must then look the transfer up instead of re-sending under a new request_id.

import { isoTime } from "../payments/evidence.ts";
import type { LedgerItem, TransferSnapshot } from "../payments/types.ts";

export const SANDBOX = "https://api.sandbox.airwallex.com";
export const API_VERSION = "2026-08-21";

type Json = any;
export interface ApiResult {
  status: number;
  data: Json;
}

export class OutcomeUnknownError extends Error {
  requestId: string;
  constructor(requestId: string, cause: unknown) {
    super(`no answer for request_id ${requestId} (${cause instanceof Error ? cause.name : "error"})`);
    this.name = "OutcomeUnknownError";
    this.requestId = requestId;
  }
}

// Sandbox limits: 20 requests per second overall, 10 per endpoint. Calls here are sequential, so spacing is enough.
export class Pacer {
  perEndpointMs: number;
  globalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  last = new Map<string, number>();
  lastAny = -Infinity;

  constructor(opts: { perEndpointMs?: number; globalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.perEndpointMs = opts.perEndpointMs ?? 110;
    this.globalMs = opts.globalMs ?? 55;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async wait(endpoint: string): Promise<void> {
    const t = this.now();
    const delay = Math.max(0, (this.last.get(endpoint) ?? -Infinity) + this.perEndpointMs - t, this.lastAny + this.globalMs - t);
    if (delay > 0) await this.sleep(delay);
    const at = this.now();
    this.last.set(endpoint, at);
    this.lastAny = at;
  }
}

// "GET /api/v1/transfers/:id" — ids and query strings do not make a new endpoint.
export const endpointOf = (method: string, path: string) =>
  `${method} ${path.replace(/\?.*$/, "").replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}(?=\/|$)/g, "/:id").replace(/\/wh_[\w-]+/g, "/:id")}`;

export class AirwallexClient {
  base: string;
  clientId: string;
  apiKey: string;
  fetch: typeof fetch;
  pacer: Pacer;
  now: () => number;
  token = "";
  expiresAt = 0;

  constructor(opts: { clientId: string; apiKey: string; base?: string; fetch?: typeof fetch; pacer?: Pacer; now?: () => number }) {
    this.clientId = opts.clientId;
    this.apiKey = opts.apiKey;
    this.base = opts.base ?? SANDBOX;
    this.fetch = opts.fetch ?? fetch;
    this.pacer = opts.pacer ?? new Pacer();
    this.now = opts.now ?? (() => Date.now());
  }

  async raw(method: string, path: string, body?: Json, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<ApiResult> {
    await this.pacer.wait(endpointOf(method, path));
    const res = await this.fetch(this.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-api-version": API_VERSION,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: Json;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { status: res.status, data };
  }

  async login(): Promise<void> {
    this.token = "";
    const r = await this.raw("POST", "/api/v1/authentication/login", undefined, { "x-client-id": this.clientId, "x-api-key": this.apiKey });
    if (r.status !== 201 || !r.data?.token) throw new Error(`login failed: HTTP ${r.status} ${r.data?.code ?? ""}`.trim());
    this.token = r.data.token;
    this.expiresAt = Date.parse(isoTime(r.data.expires_at));
  }

  // Tokens live 30 minutes; renew a minute early.
  async ensureToken(): Promise<void> {
    if (!this.token || this.now() > this.expiresAt - 60_000) await this.login();
  }

  async request(method: string, path: string, body?: Json, timeoutMs?: number): Promise<ApiResult> {
    await this.ensureToken();
    let r = await this.raw(method, path, body, {}, timeoutMs);
    if (r.status === 401) {
      await this.login();
      r = await this.raw(method, path, body, {}, timeoutMs);
    }
    return r;
  }

  getTransfer(id: string): Promise<ApiResult> {
    return this.request("GET", `/api/v1/transfers/${id}`);
  }

  // Null only when Airwallex answers that no transfer has this request_id; an error is not "not found".
  async findByRequestId(requestId: string): Promise<TransferSnapshot | null> {
    const r = await this.request("GET", `/api/v1/transfers?request_id=${encodeURIComponent(requestId)}`);
    if (r.status !== 200) throw new Error(`find by request_id: HTTP ${r.status} ${r.data?.code ?? ""}`.trim());
    return (r.data.items?.[0] as TransferSnapshot | undefined) ?? null;
  }

  async ledger(transferId: string): Promise<LedgerItem[]> {
    const r = await this.request("GET", `/api/v1/financial_transactions?source_id=${encodeURIComponent(transferId)}`);
    if (r.status !== 200) throw new Error(`ledger: HTTP ${r.status} ${r.data?.code ?? ""}`.trim());
    return (r.data.items ?? []) as LedgerItem[];
  }

  // A 4xx comes back as a result (duplicate_request_id included). No answer, or a 5xx, means Airwallex may or may not
  // have created the transfer: OutcomeUnknownError, and the caller looks it up by request_id.
  async createTransfer(body: Record<string, unknown>, timeoutMs = 30_000): Promise<ApiResult> {
    const requestId = String(body.request_id);
    const send = async () => {
      let r: ApiResult;
      try {
        r = await this.raw("POST", "/api/v1/transfers/create", body, {}, timeoutMs);
      } catch (err) {
        throw new OutcomeUnknownError(requestId, err);
      }
      if (r.status >= 500) throw new OutcomeUnknownError(requestId, new Error(`HTTP ${r.status}`));
      return r;
    };
    await this.ensureToken();
    let r = await send();
    if (r.status === 401) {
      // The token was refused before anything was created.
      await this.login();
      r = await send();
    }
    return r;
  }

  createBeneficiary(body: Record<string, unknown>): Promise<ApiResult> {
    return this.request("POST", "/api/v1/beneficiaries/create", body);
  }

  transition(id: string, nextStatus: string, failureType?: string): Promise<ApiResult> {
    const body = failureType ? { next_status: nextStatus, failure_type: failureType } : { next_status: nextStatus };
    return this.request("POST", `/api/v1/simulation/transfers/${id}/transition`, body);
  }

  createWebhook(url: string, events: string[], requestId: string): Promise<ApiResult> {
    return this.request("POST", "/api/v1/webhooks/create", { url, version: API_VERSION, events, request_id: requestId });
  }

  deleteWebhook(id: string): Promise<ApiResult> {
    return this.request("POST", `/api/v1/webhooks/${id}/delete`);
  }
}
