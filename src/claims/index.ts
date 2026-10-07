// Claim checker: an agent may only state what its evidence supports.
//
// Domain-free on purpose. Payment rules live in src/payments/claim-rules.ts; other projects (a merge-request
// reviewer, a coding agent's final report) plug in their own rules. Unknown claim kinds, missing citations and
// citations about another subject all fail closed.

export interface Evidence {
  id: string;
  kind: string;
  subject: string;
  at: string; // ISO 8601, UTC
  data: Record<string, unknown>;
}

export interface Claim {
  kind: string;
  subject: string;
  cites: string[];
}

export type Verdict = { claim: Claim; ok: true } | { claim: Claim; ok: false; reason: string };

// A rule sees the evidence the claim cites and everything known about the same subject,
// so it can refuse a claim that cites stale evidence.
export type Rule = (claim: Claim, cited: Evidence[], known: Evidence[]) => Verdict;

export function checkClaims(claims: Claim[], evidence: Evidence[], rules: Record<string, Rule>) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const verdicts: Verdict[] = claims.map((claim) => {
    const rule = rules[claim.kind];
    if (!rule) return { claim, ok: false, reason: `no rule for claim "${claim.kind}"` };
    if (claim.cites.length === 0) return { claim, ok: false, reason: "cites no evidence" };
    const missing = claim.cites.filter((id) => !byId.has(id));
    if (missing.length) return { claim, ok: false, reason: `cites unknown evidence: ${missing.join(", ")}` };
    const cited = claim.cites.map((id) => byId.get(id)!);
    const foreign = cited.filter((e) => e.subject !== claim.subject);
    if (foreign.length) {
      return { claim, ok: false, reason: `cites evidence about another subject: ${foreign.map((e) => e.id).join(", ")}` };
    }
    return rule(claim, cited, evidence.filter((e) => e.subject === claim.subject));
  });
  return { ok: verdicts.every((v) => v.ok), verdicts };
}

// A negation within the three words before a mention ("has not been paid", "is yet to be paid").
const NEGATED = /\b(?:not|never|no|isn't|hasn't|wasn't|haven't|hadn't|cannot|can't|won't|yet to)\b(?:\s+\S+){0,3}\s*$/i;

// Claim words in free text that no structured claim backs, e.g. "paid" in a reply without a "paid" claim.
// A heuristic for drafts: structured claims are what checkClaims verifies.
export function unbackedMentions(text: string, claims: Claim[], lexicon: Record<string, RegExp>): string[] {
  const declared = new Set(claims.map((c) => c.kind));
  const found: string[] = [];
  for (const [kind, pattern] of Object.entries(lexicon)) {
    if (declared.has(kind)) continue;
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      if (!NEGATED.test(before)) {
        found.push(kind);
        break;
      }
    }
  }
  return found;
}
