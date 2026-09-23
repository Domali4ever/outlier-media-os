import { getDb } from "./db";
import { nowIso, redact } from "./util";

export interface AuditInput {
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string;
  brandId?: string | null;
  summary: string;
  level?: "INFO" | "WARN" | "ERROR";
  data?: unknown;
  correlationId?: string | null;
}

export function audit(e: AuditInput) {
  getDb()
    .prepare(
      `INSERT INTO audit_events (at, actor, action, subject_type, subject_id, brand_id, summary, level, data_json, correlation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      nowIso(),
      e.actor,
      e.action,
      e.subjectType,
      e.subjectId,
      e.brandId ?? null,
      redact(e.summary),
      e.level ?? "INFO",
      e.data === undefined ? null : redact(JSON.stringify(e.data)),
      e.correlationId ?? null,
    );
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  subject_type: string;
  subject_id: string;
  brand_id: string | null;
  summary: string;
  level: string;
  data_json: string | null;
  correlation_id: string | null;
}

export function listAudit(opts: { since?: string; limit?: number; level?: string } = {}): AuditRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.since) {
    where.push("at > ?");
    args.push(opts.since);
  }
  if (opts.level) {
    where.push("level = ?");
    args.push(opts.level);
  }
  return getDb()
    .prepare(
      `SELECT * FROM audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, opts.limit ?? 100) as AuditRow[];
}
