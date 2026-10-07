// Append-only local record of what the agent saw and decided (SQLite, built into Node 22.5+).
//
// UPDATE and DELETE are refused by triggers; duplicate evidence (webhook retries) is ignored by primary key; the
// replacement lock is a row keyed by the incident — so "replace at most once" holds across restarts.

import { DatabaseSync } from "node:sqlite";
import type { Evidence } from "../claims/index.ts";
import type { Decision } from "../payments/policy.ts";

const APPEND_ONLY = ["evidence", "locks", "decisions"]
  .map((t) => `
    CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only'); END;`)
  .join("");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, at TEXT NOT NULL,
    received_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS evidence_subject ON evidence (subject);
  CREATE TABLE IF NOT EXISTS locks (
    incident_key TEXT PRIMARY KEY, replacement_request_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS decisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, incident_key TEXT NOT NULL, at TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT NOT NULL, cites TEXT NOT NULL, replacement_request_id TEXT);
  ${APPEND_ONLY}`;

type Row = Record<string, unknown>;

export class Store {
  db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  // Returns false when the item was already known (a redelivered webhook, a repeated poll).
  addEvidence(e: Evidence, receivedAt: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO evidence (id, kind, subject, at, received_at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.id, e.kind, e.subject, e.at, receivedAt, JSON.stringify(e.data));
    return r.changes === 1;
  }

  evidence(subject?: string): Evidence[] {
    const rows = (subject === undefined
      ? this.db.prepare("SELECT * FROM evidence ORDER BY at, id").all()
      : this.db.prepare("SELECT * FROM evidence WHERE subject = ? ORDER BY at, id").all(subject)) as Row[];
    return rows.map((r) => ({
      id: String(r.id), kind: String(r.kind), subject: String(r.subject), at: String(r.at),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
    }));
  }

  // At most one replacement per incident. A second attempt gets the first request_id back instead of a new one.
  lockReplacement(incidentKey: string, replacementRequestId: string, at: string): { acquired: boolean; replacementRequestId: string } {
    const existing = this.replacementFor(incidentKey);
    if (existing) return { acquired: false, replacementRequestId: existing };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO locks (incident_key, replacement_request_id, created_at) VALUES (?, ?, ?)")
        .run(incidentKey, replacementRequestId, at);
      this.addEvidence(
        { id: `lock:${incidentKey}`, kind: "replacement", subject: incidentKey, at, data: { replacementRequestId } },
        at,
      );
      this.db.exec("COMMIT");
      return { acquired: true, replacementRequestId };
    } catch (err) {
      this.db.exec("ROLLBACK");
      const winner = this.replacementFor(incidentKey);
      if (winner) return { acquired: false, replacementRequestId: winner };
      throw err;
    }
  }

  replacementFor(incidentKey: string): string | null {
    const row = this.db.prepare("SELECT replacement_request_id FROM locks WHERE incident_key = ?").get(incidentKey) as Row | undefined;
    return row ? String(row.replacement_request_id) : null;
  }

  recordDecision(incidentKey: string, d: Decision, at: string): void {
    this.db
      .prepare("INSERT INTO decisions (incident_key, at, action, reason, cites, replacement_request_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(incidentKey, at, d.action, d.reason, JSON.stringify(d.cites), d.replacementRequestId ?? null);
  }

  decisions(incidentKey: string): (Decision & { at: string })[] {
    const rows = this.db.prepare("SELECT * FROM decisions WHERE incident_key = ? ORDER BY seq").all(incidentKey) as Row[];
    return rows.map((r) => ({
      at: String(r.at),
      action: r.action as Decision["action"],
      reason: String(r.reason),
      cites: JSON.parse(String(r.cites)) as string[],
      ...(r.replacement_request_id ? { replacementRequestId: String(r.replacement_request_id) } : {}),
    }));
  }

  close(): void {
    this.db.close();
  }
}
