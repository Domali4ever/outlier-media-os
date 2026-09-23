import { getDb, tx } from "./db";
import { audit } from "./audit";
import { AppError, newId, nowIso, parseJson } from "./util";

export interface PolicyRow {
  id: string;
  brand_id: string | null;
  kind: string;
  version: number;
  config_json: string;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface BudgetConfig {
  amount: number;
  currency: string;
  period: "month";
}

export interface RecurringPublicationConfig {
  destination: string;
  maxPerWeek: number;
}

export function activePolicy(kind: string, brandId: string | null): PolicyRow | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM policies WHERE kind = ? AND status = 'ACTIVE' AND (brand_id IS ? OR brand_id = ?) ORDER BY version DESC LIMIT 1",
    )
    .get(kind, brandId, brandId) as PolicyRow | undefined;
}

export function listPolicies(brandId: string): PolicyRow[] {
  return getDb()
    .prepare("SELECT * FROM policies WHERE brand_id = ? ORDER BY kind, version DESC")
    .all(brandId) as PolicyRow[];
}

/** Creates a new ACTIVE version of a policy, superseding the previous one. Human action (level 4). */
export function setPolicy(brandId: string, kind: string, config: unknown, actor: string): PolicyRow {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator can set or change policies.", 403);
  return tx(() => {
    const db = getDb();
    const prev = db
      .prepare("SELECT MAX(version) v FROM policies WHERE brand_id = ? AND kind = ?")
      .get(brandId, kind) as { v: number | null };
    db.prepare("UPDATE policies SET status='SUPERSEDED' WHERE brand_id = ? AND kind = ? AND status='ACTIVE'").run(
      brandId,
      kind,
    );
    const id = newId("policy");
    const now = nowIso();
    db.prepare(
      `INSERT INTO policies (id, brand_id, kind, version, config_json, status, approved_by, approved_at, created_at)
       VALUES (?,?,?,?,?, 'ACTIVE', ?, ?, ?)`,
    ).run(id, brandId, kind, (prev.v ?? 0) + 1, JSON.stringify(config), actor, now, now);
    audit({
      actor,
      action: "policy.set",
      subjectType: "policy",
      subjectId: id,
      brandId,
      summary: `Policy ${kind} v${(prev.v ?? 0) + 1} activated`,
      data: config,
    });
    return db.prepare("SELECT * FROM policies WHERE id = ?").get(id) as PolicyRow;
  });
}

export function revokePolicy(brandId: string, kind: string, actor: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator can revoke policies.", 403);
  const n = getDb()
    .prepare("UPDATE policies SET status='REVOKED', revoked_at=? WHERE brand_id=? AND kind=? AND status='ACTIVE'")
    .run(nowIso(), brandId, kind).changes;
  audit({ actor, action: "policy.revoke", subjectType: "policy", subjectId: kind, brandId, summary: `Policy ${kind} revoked` });
  return n;
}

function monthStart(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export interface BudgetStatus {
  cap: BudgetConfig | null;
  spent: number;
  spentIncludesEstimates: boolean;
  remaining: number | null;
  periodStart: string;
}

export function budgetStatus(brandId: string): BudgetStatus {
  const p = activePolicy("budget", brandId);
  const cap = p ? parseJson<BudgetConfig | null>(p.config_json, null) : null;
  const start = monthStart();
  const r = getDb()
    .prepare(
      "SELECT COALESCE(SUM(amount),0) s, COALESCE(MAX(is_estimate),0) e FROM costs WHERE brand_id = ? AND category IN ('ai','external') AND incurred_at >= ?" +
        (cap ? " AND currency = ?" : ""),
    )
    .get(...([brandId, start].concat(cap ? [cap.currency] : [])) as unknown[]) as { s: number; e: number };
  return {
    cap,
    spent: r.s,
    spentIncludesEstimates: r.e === 1,
    remaining: cap ? Math.max(0, cap.amount - r.s) : null,
    periodStart: start,
  };
}

/** Returns a blocking reason, or null when spending is authorized. Unknown pricing still needs a cap. */
export function budgetBlockReason(brandId: string | null): string | null {
  if (!brandId) return "No brand context for a paid job.";
  const b = budgetStatus(brandId);
  if (!b.cap) return "No AI/external spend cap is set. Set one in SYSTEM › AUTOMATIONS.";
  if (b.remaining !== null && b.remaining <= 0)
    return `Spend cap reached (${b.spent.toFixed(2)} of ${b.cap.amount.toFixed(2)} ${b.cap.currency} this month).`;
  return null;
}
