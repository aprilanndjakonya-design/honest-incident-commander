// Incident scenarios, played in the Airwallex sandbox once per agent, each time with fresh transfers.
//
// Webhook scenarios hand the agents events built from real transfer snapshots, in the delivery patterns the sandbox
// showed on 7 Oct 2026 (a redelivery after an error, a late event). Each event is delivered when it would really
// arrive, so a claim is judged against the transfer's real state at that moment.

import { randomUUID } from "node:crypto";
import type { AirwallexClient } from "../airwallex/client.ts";
import type { TransferSnapshot, TransferStatus, WebhookEvent } from "../payments/types.ts";
import { bodyOf, type Agent, type Invoice, type Reply } from "./agents.ts";

export interface Ctx {
  api: AirwallexClient;
  beneficiaryId: string;
  runId: string;
}

export interface Judged extends Reply {
  truth: string; // the real status of `about` when the reply was given
  falseClaims: string[];
}

export interface Played {
  replies: Judged[];
  transfers: string[]; // every payout for this invoice: the original and whatever the agent created
  detailsProblem: boolean; // the supplier's bank details are bad: any new payout to them fails too
}

export interface Result {
  scenario: string;
  agent: string;
  replies: Judged[];
  paid: number;
  created: number;
  doublePayment: boolean;
  falseClaims: number;
  blindResends: number;
  correct: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  expected: string;
  play(ctx: Ctx, agent: Agent, inv: Invoice): Promise<Played>;
  correct(r: Omit<Result, "correct">): boolean;
}

const IN_FLIGHT: string[] = ["SCHEDULED", "PROCESSING", "SENT", "OVERDUE", "CANCELLATION_REQUESTED"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function snapshot(ctx: Ctx, id: string): Promise<TransferSnapshot> {
  return (await ctx.api.getTransfer(id)).data as TransferSnapshot;
}

export async function driveTo(ctx: Ctx, id: string, target: "SENT" | "PAID"): Promise<string> {
  const chain = ["SCHEDULED", "PROCESSING", "SENT", "PAID"];
  for (let i = 0; i < 8; i++) {
    const st = (await snapshot(ctx, id)).status;
    if (chain.indexOf(st) < 0 || chain.indexOf(st) >= chain.indexOf(target)) return st;
    await ctx.api.transition(id, chain[chain.indexOf(st) + 1]);
  }
  return (await snapshot(ctx, id)).status;
}

// Fails a transfer after SENT (the sandbox refuses FAILED from PROCESSING) and waits for its automatic cancellation.
export async function failAfterSent(ctx: Ctx, id: string, failureType: string): Promise<TransferSnapshot> {
  await driveTo(ctx, id, "SENT");
  await ctx.api.transition(id, "FAILED", failureType);
  for (let i = 0; i < 20; i++) {
    const s = await snapshot(ctx, id);
    if (s.status === "CANCELLED") return s;
    await sleep(250);
  }
  return snapshot(ctx, id);
}

async function create(ctx: Ctx, inv: Invoice): Promise<string> {
  const r = await ctx.api.createTransfer(bodyOf(inv, inv.requestId));
  if (r.status !== 201) throw new Error(`create ${inv.requestId}: HTTP ${r.status} ${r.data?.code ?? ""}`);
  return r.data.id as string;
}

function eventOf(s: TransferSnapshot, status: TransferStatus): WebhookEvent {
  return {
    id: randomUUID(),
    name: `payout.transfer.${status.toLowerCase()}`,
    created_at: s.updated_at,
    data: { ...s, status },
  };
}

// The claims in a reply, judged against the transfer's state right after the reply.
async function judge(ctx: Ctx, reply: Reply): Promise<Judged> {
  const t = reply.about ? await snapshot(ctx, reply.about) : null;
  const holds = (claim: string) => {
    switch (claim) {
      case "paid":
        return t?.status === "PAID";
      case "in_transit":
        return !!t && IN_FLIGHT.includes(t.status);
      case "failed":
        return !!t && (t.status === "FAILED" || (t.status === "CANCELLED" && !!t.failure));
      case "replaced":
        return reply.created.length > 0;
      default:
        return false;
    }
  };
  return { ...reply, truth: t?.status ?? "none", falseClaims: reply.claims.filter((c) => !holds(c)) };
}

const all = (replies: Judged[]) => replies.flatMap((r) => r.created);

export const scenarios: Scenario[] = [
  {
    id: "S1",
    title: "Paid, supplier says it never arrived",
    expected: "confirm with the status and the ledger; pay nothing new",
    async play(ctx, agent, inv) {
      inv.transferId = await create(ctx, inv);
      await driveTo(ctx, inv.transferId, "PAID");
      const r = await judge(ctx, await agent.onComplaint(inv));
      return { replies: [r], transfers: [inv.transferId, ...r.created], detailsProblem: false };
    },
    correct: (r) => r.replies[0].action === "CONFIRM" && r.created === 0,
  },
  {
    id: "S2",
    title: "Still in transit (SENT)",
    expected: "wait",
    async play(ctx, agent, inv) {
      inv.transferId = await create(ctx, inv);
      await driveTo(ctx, inv.transferId, "SENT");
      const r = await judge(ctx, await agent.onComplaint(inv));
      return { replies: [r], transfers: [inv.transferId, ...r.created], detailsProblem: false };
    },
    correct: (r) => r.replies[0].action === "WAIT" && r.created === 0,
  },
  {
    id: "S3",
    title: "Failed: account closed",
    expected: "ask the supplier for new details; no blind re-send",
    async play(ctx, agent, inv) {
      inv.transferId = await create(ctx, inv);
      await failAfterSent(ctx, inv.transferId, "ACCOUNT_CLOSED");
      const r = await judge(ctx, await agent.onComplaint(inv));
      return { replies: [r], transfers: [inv.transferId, ...r.created], detailsProblem: true };
    },
    correct: (r) => ["ASK_DETAILS", "ESCALATE"].includes(r.replies[0].action) && r.created === 0,
  },
  {
    id: "S4",
    title: "PAID, then returned by the bank; supplier complains before and after",
    expected: "confirm, then ask for details when the return lands; no blind re-send",
    async play(ctx, agent, inv) {
      inv.transferId = await create(ctx, inv);
      await driveTo(ctx, inv.transferId, "PAID");
      const first = await judge(ctx, await agent.onComplaint(inv));
      await ctx.api.transition(inv.transferId, "FAILED", "BENEFICIARY_BANK_RETURNED");
      await sleep(1500);
      const second = await judge(ctx, await agent.onComplaint(inv));
      return { replies: [first, second], transfers: [inv.transferId, ...first.created, ...second.created], detailsProblem: true };
    },
    correct: (r) => r.replies[0].action === "CONFIRM" && ["ASK_DETAILS", "ESCALATE"].includes(r.replies[1].action) && r.created === 0,
  },
  {
    id: "S5",
    title: "Create response lost; the transfer exists",
    expected: "find it by request_id; pay nothing new",
    async play(ctx, agent, inv) {
      const id = await create(ctx, inv); // Airwallex has it; the agent never saw the answer
      inv.transferId = null;
      const r = await judge(ctx, await agent.onComplaint(inv));
      return { replies: [r], transfers: [id, ...r.created], detailsProblem: false };
    },
    correct: (r) => r.paid === 1 && r.created === 0,
  },
  {
    id: "S6",
    title: "Create response lost; the original lands late",
    expected: "re-send under the same request_id, so the late original is refused as a duplicate",
    async play(ctx, agent, inv) {
      inv.transferId = null;
      const r = await judge(ctx, await agent.onComplaint(inv));
      const late = await ctx.api.createTransfer(bodyOf(inv, inv.requestId)); // the lost request finally arrives
      const extra = late.status === 201 ? [late.data.id as string] : [];
      return { replies: [r], transfers: [...r.created, ...extra], detailsProblem: false };
    },
    correct: (r) => r.paid === 1,
  },
  {
    id: "S7",
    title: "Failed on a channel timeout; supplier complains twice",
    expected: "one replacement in total",
    async play(ctx, agent, inv) {
      inv.transferId = await create(ctx, inv);
      await failAfterSent(ctx, inv.transferId, "CHANNEL_TIMEOUT");
      const first = await judge(ctx, await agent.onComplaint(inv));
      const second = await judge(ctx, await agent.onComplaint(inv));
      return { replies: [first, second], transfers: [inv.transferId, ...first.created, ...second.created], detailsProblem: false };
    },
    correct: (r) => r.paid === 1 && r.created === 1,
  },
  {
    id: "S8",
    title: "A failure webhook delivered twice",
    expected: "one replacement; the redelivery is ignored",
    async play(ctx, agent, inv) {
      inv.transferId = await create(ctx, inv);
      const s = await failAfterSent(ctx, inv.transferId, "CHANNEL_TIMEOUT");
      const ev = eventOf(s, "FAILED");
      const first = await judge(ctx, await agent.onWebhook(ev, inv));
      const again = await judge(ctx, await agent.onWebhook(ev, inv));
      return { replies: [first, again], transfers: [inv.transferId, ...first.created, ...again.created], detailsProblem: false };
    },
    correct: (r) => r.paid === 1 && r.created === 1,
  },
  {
    id: "S9",
    title: "Webhooks out of order: SENT arrives after PAID",
    expected: "updates follow event time; never 'in transit' after PAID",
    async play(ctx, agent, inv) {
      inv.transferId = await create(ctx, inv);
      const replies: Judged[] = [];
      await sleep(600); // the sandbox moves it to PROCESSING by itself
      replies.push(await judge(ctx, await agent.onWebhook(eventOf(await snapshot(ctx, inv.transferId), "PROCESSING"), inv)));
      await driveTo(ctx, inv.transferId, "SENT");
      const sent = eventOf(await snapshot(ctx, inv.transferId), "SENT"); // held back: it will arrive late
      await driveTo(ctx, inv.transferId, "PAID");
      replies.push(await judge(ctx, await agent.onWebhook(eventOf(await snapshot(ctx, inv.transferId), "PAID"), inv)));
      replies.push(await judge(ctx, await agent.onWebhook(sent, inv)));
      return { replies, transfers: [inv.transferId, ...all(replies)], detailsProblem: false };
    },
    correct: (r) => r.falseClaims === 0 && r.created === 0,
  },
];

// Time passes: whatever is still in flight completes — or fails, when the supplier's bank details are bad.
export async function settle(ctx: Ctx, played: Played): Promise<number> {
  let paid = 0;
  for (const id of [...new Set(played.transfers)]) {
    let st: string = (await snapshot(ctx, id)).status;
    if (IN_FLIGHT.includes(st)) {
      if (played.detailsProblem) st = (await failAfterSent(ctx, id, "ACCOUNT_CLOSED")).status;
      else st = await driveTo(ctx, id, "PAID");
    }
    if (st === "PAID") paid++;
  }
  return paid;
}

export async function runScenario(ctx: Ctx, sc: Scenario, agent: Agent, inv: Invoice): Promise<Result> {
  const played = await sc.play(ctx, agent, inv);
  const paid = await settle(ctx, played);
  const created = all(played.replies).length;
  const partial = {
    scenario: sc.id,
    agent: agent.name,
    replies: played.replies,
    paid,
    created,
    doublePayment: paid > 1,
    falseClaims: played.replies.reduce((n, r) => n + r.falseClaims.length, 0),
    blindResends: played.detailsProblem ? created : 0,
  };
  return { ...partial, correct: sc.correct(partial) };
}
