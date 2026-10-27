// The model behind the agent's words. It reads supplier messages and drafts replies; it never picks an action
// (src/payments/policy.ts does) and never touches money. Every call is metered against a hard budget that survives
// restarts, so a loop or a long run cannot spend past it.

import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Effort = "low" | "medium" | "high";

export interface JsonRequest {
  purpose: string; // for the call log: "intake", "reply", ...
  system: string;
  user: string;
  schema: Record<string, unknown>; // JSON schema of the answer; the API constrains the output to it
  effort?: Effort;
  maxTokens?: number;
}

export interface Model {
  json<T>(req: JsonRequest): Promise<T>;
}

export class BudgetExceededError extends Error {}
export class ModelRefusedError extends Error {}

// USD per million tokens, input and output. OpenRouter bills the same and reports the cost itself; this table is
// the fallback when a response carries no cost.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "anthropic/claude-opus-5.5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "anthropic/claude-sonnet-5.5": [2, 10],
};

// Total spend in a small JSON file plus one log line per call. Sequential use only.
export class Meter {
  path: string;
  capUsd: number;

  constructor(path: string, capUsd: number) {
    this.path = path;
    this.capUsd = capUsd;
  }

  spent(): number {
    return existsSync(this.path) ? Number(JSON.parse(readFileSync(this.path, "utf8")).usd) || 0 : 0;
  }

  check(): void {
    const spent = this.spent();
    if (spent >= this.capUsd) throw new BudgetExceededError(`model budget used up: $${spent.toFixed(4)} of $${this.capUsd}`);
  }

  add(usd: number, entry: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const usdTotal = this.spent() + usd;
    writeFileSync(this.path, JSON.stringify({ usd: usdTotal, cap: this.capUsd, updated: new Date().toISOString() }) + "\n");
    appendFileSync(this.path.replace(/\.json$/, ".jsonl"), JSON.stringify({ at: new Date().toISOString(), usd, ...entry }) + "\n");
  }
}

export class ClaudeModel implements Model {
  client: Anthropic;
  model: string;
  meter: Meter;

  constructor(client: Anthropic, model: string, meter: Meter) {
    this.client = client;
    this.model = model;
    this.meter = meter;
  }

  async json<T>(req: JsonRequest): Promise<T> {
    this.meter.check();
    const r = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort ?? "low", format: { type: "json_schema", schema: req.schema } },
    });
    const u = r.usage as typeof r.usage & { cost?: number };
    const [pin, pout] = PRICES[this.model] ?? [4, 20];
    const usd = typeof u.cost === "number" ? u.cost : (u.input_tokens * pin + u.output_tokens * pout) / 1e6;
    this.meter.add(usd, { purpose: req.purpose, model: this.model, input: u.input_tokens, output: u.output_tokens, stop: r.stop_reason });
    if (r.stop_reason === "refusal") throw new ModelRefusedError(`${req.purpose}: the model declined`);
    if (r.stop_reason === "max_tokens") throw new Error(`${req.purpose}: the answer hit max_tokens`);
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return JSON.parse(text) as T;
  }
}

// ANTHROPIC_API_KEY talks to Anthropic directly; OPENROUTER_API_KEY goes through OpenRouter's Anthropic-compatible
// endpoint with the same SDK. The base URL is always explicit, so an ANTHROPIC_BASE_URL in the shell is not picked up.
export function modelFromEnv(env: Record<string, string>, meterPath = "runs/llm-spend.json"): ClaudeModel | null {
  const meter = new Meter(meterPath, Number(env.LLM_BUDGET_USD || 20));
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ baseURL: "https://api.anthropic.com", apiKey: env.ANTHROPIC_API_KEY, authToken: null });
    return new ClaudeModel(client, env.LLM_MODEL || "claude-opus-5-5", meter);
  }
  if (env.OPENROUTER_API_KEY) {
    const client = new Anthropic({ baseURL: "https://openrouter.ai/api", authToken: env.OPENROUTER_API_KEY, apiKey: null });
    return new ClaudeModel(client, env.LLM_MODEL || "anthropic/claude-opus-5.5", meter);
  }
  return null;
}
