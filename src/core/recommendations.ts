import { getDb, tx } from "./db";
import { audit } from "./audit";
import { createJob } from "./jobs";
import { retireContent } from "./content";
import { type RecommendationType } from "./types";
import { AppError, newId, nowIso, parseJson } from "./util";

export interface RecommendationRow {
  id: string;
  brand_id: string;
  type: RecommendationType;
  subject_type: string;
  subject_id: string;
  title: string;
  reason: string;
  evidence_json: string;
  upside: string;
  risks: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  data_sufficiency: "INSUFFICIENT" | "PARTIAL" | "SUFFICIENT";
  status: "OPEN" | "APPROVED" | "REJECTED" | "DONE" | "SUPERSEDED";
  rule_key: string;
  legacy: number;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

/** Documented thresholds. Recommendations are derived only from stored observations. */
export const RULES = {
  windowDays: 28,
  minCoverageDays: 14,
  scaleMinViews: 500,
  modifyMinViewsNoClicks: 300,
  killMinAgeDays: 60,
  killMaxViews: 50,
};

type Draft = Omit<RecommendationRow, "id" | "status" | "created_at" | "decided_at" | "decided_by" | "legacy" | "evidence_json"> & { evidence: string[] };

export function computeRecommendations(brandId: string): Draft[] {
  const db = getDb();
  const out: Draft[] = [];
  const pubs = db
    .prepare(
      `SELECT c.id, c.title, MIN(p.created_at) published_at FROM content_items c JOIN publications p ON p.content_id = c.id
       WHERE c.brand_id = ? AND c.retired_at IS NULL AND p.status IN ('CONFIRMED','MANUAL_CONFIRMED') GROUP BY c.id`,
    )
    .all(brandId) as { id: string; title: string; published_at: string }[];
  const since = new Date(Date.now() - RULES.windowDays * 86400_000).toISOString();
  for (const p of pubs) {
    const obs = db
      .prepare("SELECT metric, SUM(value) v, MIN(period_start) s, MAX(period_end) e, COUNT(*) n FROM performance_observations WHERE content_id = ? AND period_end >= ? GROUP BY metric")
      .all(p.id, since) as { metric: string; v: number; s: string; e: string; n: number }[];
    const m = Object.fromEntries(obs.map((o) => [o.metric, o]));
    const views = m.views;
    const ageDays = (Date.now() - new Date(p.published_at).getTime()) / 86400_000;
    if (!views) {
      out.push({
        brand_id: brandId, type: "INVESTIGATE", subject_type: "content", subject_id: p.id,
        title: `No performance data for “${p.title}”`,
        reason: "The item is published but no views have been ingested in the measurement window.",
        evidence: [`Published ${p.published_at.slice(0, 10)}`, "0 view observations in the last 28 days"],
        upside: "Connecting analytics or importing a report makes a real recommendation possible.",
        risks: "Without data, scaling or killing this item would be a guess.",
        confidence: "LOW", data_sufficiency: "INSUFFICIENT", rule_key: `nodata:${p.id}`,
      });
      continue;
    }
    const coverage = (new Date(views.e).getTime() - new Date(views.s).getTime()) / 86400_000;
    const ev = obs.map((o) => `${o.metric}: ${o.v} (${o.s.slice(0, 10)} → ${o.e.slice(0, 10)}, ${o.n} obs)`);
    if (coverage < RULES.minCoverageDays) {
      out.push({
        brand_id: brandId, type: "INVESTIGATE", subject_type: "content", subject_id: p.id,
        title: `Too little measured time for “${p.title}”`,
        reason: `Only ${coverage.toFixed(0)} days of view data; ${RULES.minCoverageDays} are needed.`,
        evidence: ev, upside: "Wait for more coverage.", risks: "Early numbers are noisy.",
        confidence: "LOW", data_sufficiency: "PARTIAL", rule_key: `coverage:${p.id}`,
      });
      continue;
    }
    const conv = m.conversions?.v ?? null;
    const clicks = m.clicks?.v ?? null;
    if (views.v >= RULES.scaleMinViews && conv !== null && conv > 0) {
      out.push({
        brand_id: brandId, type: "SCALE", subject_type: "content", subject_id: p.id,
        title: `Scale “${p.title}”`, reason: `${views.v} views and ${conv} conversions in ${RULES.windowDays} days.`,
        evidence: ev, upside: "Related topics in the same pillar are likely to convert.", risks: "Conversions may be few; attribution windows vary by program.",
        confidence: conv >= 5 ? "MEDIUM" : "LOW", data_sufficiency: "SUFFICIENT", rule_key: `scale:${p.id}`,
      });
    } else if (views.v >= RULES.modifyMinViewsNoClicks && clicks !== null && clicks === 0) {
      out.push({
        brand_id: brandId, type: "MODIFY", subject_type: "content", subject_id: p.id,
        title: `Traffic without clicks on “${p.title}”`, reason: `${views.v} views but 0 affiliate clicks.`,
        evidence: ev, upside: "Better offer placement or a more relevant offer.", risks: "The offer may be a poor fit for this intent.",
        confidence: "MEDIUM", data_sufficiency: "SUFFICIENT", rule_key: `modify:${p.id}`,
      });
    } else if (ageDays >= RULES.killMinAgeDays && views.v < RULES.killMaxViews) {
      out.push({
        brand_id: brandId, type: "KILL", subject_type: "content", subject_id: p.id,
        title: `Retire “${p.title}”?`, reason: `${views.v} views in ${RULES.windowDays} days after ${ageDays.toFixed(0)} days live.`,
        evidence: ev, upside: "Focus effort on items that get traffic.", risks: "Search traffic can arrive late; retiring is reversible in the app but the live page stays until you remove it.",
        confidence: "LOW", data_sufficiency: "SUFFICIENT", rule_key: `kill:${p.id}`,
      });
    } else {
      out.push({
        brand_id: brandId, type: "MAINTAIN", subject_type: "content", subject_id: p.id,
        title: `Maintain “${p.title}”`, reason: `${views.v} views in ${RULES.windowDays} days; no rule suggests a change.`,
        evidence: ev, upside: "", risks: "", confidence: "MEDIUM", data_sufficiency: "SUFFICIENT", rule_key: `maintain:${p.id}`,
      });
    }
  }
  const legacy = db.prepare("SELECT id, title FROM content_items WHERE brand_id = ? AND legacy = 1 AND verification_status = 'UNVERIFIED' AND retired_at IS NULL").all(brandId) as { id: string; title: string }[];
  for (const l of legacy) {
    out.push({
      brand_id: brandId, type: "INVESTIGATE", subject_type: "content", subject_id: l.id,
      title: `Legacy item “${l.title}” has unverified history`,
      reason: "It was imported with claims (approval, QA or qualification) that match no saved record.",
      evidence: ["Imported as UNVERIFIED history"], upside: "Verifying it lets it move through the normal gates.",
      risks: "Honoring unverified claims could publish unchecked statements.",
      confidence: "MEDIUM", data_sufficiency: "PARTIAL", rule_key: `legacy:${l.id}`,
    });
  }
  const legacyPrograms = db.prepare("SELECT id, name FROM programs WHERE brand_id = ? AND legacy = 1 AND program_status = 'DISCOVERED'").all(brandId) as { id: string; name: string }[];
  for (const l of legacyPrograms) {
    out.push({
      brand_id: brandId, type: "INVESTIGATE", subject_type: "program", subject_id: l.id,
      title: `Legacy program “${l.name}” has no saved evidence`,
      reason: "An imported record claims qualification but no source URLs or checked dates were saved.",
      evidence: ["Imported as UNVERIFIED history"], upside: "If verified, it can be qualified properly.",
      risks: "Activating an unverified program could breach its AI, video or disclosure policy.",
      confidence: "LOW", data_sufficiency: "INSUFFICIENT", rule_key: `legacyprog:${l.id}`,
    });
  }
  return out;
}

/** Upserts recommendations by rule key and supersedes open ones that no longer apply. */
export function refreshRecommendations(brandId: string, actor = "system"): { created: number; superseded: number } {
  const drafts = computeRecommendations(brandId);
  const db = getDb();
  let created = 0;
  let superseded = 0;
  tx(() => {
    const open = db.prepare("SELECT * FROM recommendations WHERE brand_id = ? AND status = 'OPEN'").all(brandId) as RecommendationRow[];
    const keys = new Set(drafts.map((d) => d.rule_key));
    for (const o of open) {
      if (!keys.has(o.rule_key)) {
        db.prepare("UPDATE recommendations SET status='SUPERSEDED', decided_at=? WHERE id=?").run(nowIso(), o.id);
        superseded++;
      }
    }
    for (const d of drafts) {
      const exists = db.prepare("SELECT 1 FROM recommendations WHERE brand_id = ? AND rule_key = ? AND status IN ('OPEN','REJECTED','APPROVED','DONE') AND created_at > ?").get(brandId, d.rule_key, new Date(Date.now() - 7 * 86400_000).toISOString());
      if (exists) continue;
      db.prepare(
        `INSERT INTO recommendations (id, brand_id, type, subject_type, subject_id, title, reason, evidence_json, upside, risks, confidence, data_sufficiency, status, rule_key, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'OPEN', ?, ?)`,
      ).run(newId("rec"), brandId, d.type, d.subject_type, d.subject_id, d.title, d.reason, JSON.stringify(d.evidence), d.upside, d.risks, d.confidence, d.data_sufficiency, d.rule_key, nowIso());
      created++;
    }
  });
  if (created || superseded) audit({ actor, action: "recommendations.refresh", subjectType: "brand", subjectId: brandId, brandId, summary: `Recommendations refreshed: ${created} new, ${superseded} superseded` });
  return { created, superseded };
}

export function listOpenRecommendations(brandId: string): RecommendationRow[] {
  return getDb().prepare("SELECT * FROM recommendations WHERE brand_id = ? AND status = 'OPEN' ORDER BY created_at DESC").all(brandId) as RecommendationRow[];
}

export function getRecommendation(id: string): RecommendationRow {
  const r = getDb().prepare("SELECT * FROM recommendations WHERE id = ?").get(id) as RecommendationRow | undefined;
  if (!r) throw new AppError("NOT_FOUND", "Recommendation not found", 404);
  return r;
}

/** APPROVE executes the recommendation's reversible follow-up (if any); REJECT records the decision. */
export function decideRecommendation(id: string, decision: "APPROVED" | "REJECTED", actor: string): { followUp: string | null } {
  if (actor !== "operator") throw new AppError("PERMISSION", "Recommendations are decided by the operator.", 403);
  const r = getRecommendation(id);
  if (r.status !== "OPEN") throw new AppError("BAD_STATE", `Recommendation is ${r.status}.`);
  let followUp: string | null = null;
  if (decision === "APPROVED") {
    if (r.type === "KILL" && r.subject_type === "content") {
      retireContent(r.subject_id, actor);
      followUp = `Retired ${r.subject_id} in the app. Remove or unpublish the live page yourself if you want it gone.`;
    } else if (r.type === "MODIFY" && r.subject_type === "content") {
      const c = getDb().prepare("SELECT brand_id, current_revision_id FROM content_items WHERE id = ?").get(r.subject_id) as { brand_id: string; current_revision_id: string };
      const { job } = createJob({ type: "REVISE", brandId: c.brand_id, contentId: r.subject_id, revisionId: c.current_revision_id, actor, input: { instruction: `${r.title}. ${r.reason}` }, rerun: true });
      followUp = `Revision job ${job.id} ${job.state}.`;
    }
  }
  getDb().prepare("UPDATE recommendations SET status=?, decided_at=?, decided_by=? WHERE id=?").run(decision === "APPROVED" && !followUp ? "APPROVED" : decision === "APPROVED" ? "DONE" : "REJECTED", nowIso(), actor, id);
  audit({ actor, action: `recommendation.${decision.toLowerCase()}`, subjectType: r.subject_type, subjectId: r.subject_id, brandId: r.brand_id, summary: `${r.type} “${r.title}” ${decision}${followUp ? ` — ${followUp}` : ""}` });
  return { followUp };
}

export function recEvidence(r: RecommendationRow): string[] {
  return parseJson<string[]>(r.evidence_json, []);
}
