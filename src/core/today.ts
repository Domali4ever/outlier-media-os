import { getDb } from "./db";
import { audit, listAudit } from "./audit";
import { activationBlockers, getAvatars, getBrand } from "./brand";
import { editorialReadiness, getContent, listContent } from "./content";
import { getIntegration, isCapabilityReady } from "./integrations";
import { jobCounts, listJobs } from "./jobs";
import { budgetStatus } from "./policies";
import { listOpenRecommendations, recEvidence } from "./recommendations";
import { isSystemPaused } from "./settings";
import { CAP } from "./types";
import { nowIso } from "./util";

export type DataState = "MEASURED" | "NOT_CONNECTED" | "NO_DATA" | "STALE" | "PARTIAL" | "ESTIMATED" | "NOT_CALCULABLE";

export interface Tile {
  key: string;
  label: string;
  value: string;
  state: DataState;
  source: string;
}

export function lastCheckIn(): string | null {
  const r = getDb().prepare("SELECT at FROM checkins ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined;
  return r?.at ?? null;
}

export function recordCheckIn(actor: string) {
  getDb().prepare("INSERT INTO checkins (at, actor) VALUES (?,?)").run(nowIso(), actor);
  audit({ actor, action: "checkin", subjectType: "system", subjectId: "checkin", summary: "Operator check-in recorded" });
}

function fmtMoney(n: number, cur: string) {
  return `${cur} ${n.toFixed(2)}`;
}

export function sinceLastCheckIn(brandId: string): { since: string; firstSession: boolean; tiles: Tile[]; currency: string } {
  const db = getDb();
  const brand = getBrand(brandId);
  const last = lastCheckIn();
  const since = last ?? brand.created_at;
  const cur = brand.currency;
  const q = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T;

  const produced = q<{ n: number }>(
    "SELECT COUNT(*) n FROM content_revisions r JOIN content_items c ON c.id = r.content_id WHERE c.brand_id = ? AND r.created_at > ? AND r.number > 1",
    brandId,
    since,
  ).n;
  const published = q<{ n: number }>(
    "SELECT COUNT(*) n FROM publications p JOIN content_items c ON c.id = p.content_id WHERE c.brand_id = ? AND p.created_at > ? AND p.status IN ('CONFIRMED','MANUAL_CONFIRMED')",
    brandId,
    since,
  ).n;
  const pubReady = isCapabilityReady(CAP.PUBLISH);
  const everPublished = q<{ n: number }>("SELECT COUNT(*) n FROM publications p JOIN content_items c ON c.id=p.content_id WHERE c.brand_id=?", brandId).n;

  const metricTile = (metric: string, label: string, sourceKind: "analytics" | "affiliate"): Tile => {
    const r = q<{ v: number | null; n: number; last: string | null }>(
      `SELECT SUM(value) v, COUNT(*) n, MAX(observed_at) last FROM performance_observations WHERE brand_id = ? AND metric = ? AND period_end > ?`,
      brandId,
      metric,
      since,
    );
    const ever = q<{ n: number; last: string | null }>("SELECT COUNT(*) n, MAX(observed_at) last FROM performance_observations WHERE brand_id=? AND metric=?", brandId, metric);
    const connected = sourceKind === "analytics" ? isCapabilityReady(CAP.ANALYTICS) : false;
    const staleMs = sourceKind === "analytics" ? 2 * 86400_000 : 8 * 86400_000;
    let state: DataState;
    let source: string;
    if (ever.n === 0) {
      state = sourceKind === "analytics" && !connected ? "NOT_CONNECTED" : "NO_DATA";
      source = sourceKind === "analytics" ? (connected ? "GA4 connected · no data yet" : "No analytics source connected") : "No affiliate report imported";
    } else if (ever.last && Date.now() - new Date(ever.last).getTime() > staleMs) {
      state = "STALE";
      source = `Last synced ${ever.last.slice(0, 16).replace("T", " ")} UTC`;
    } else {
      state = everPublished > 0 && sourceKind === "analytics" && !connected ? "PARTIAL" : "MEASURED";
      source = `${r.n} observation(s) · synced ${ever.last?.slice(0, 16).replace("T", " ")} UTC`;
    }
    const value = state === "NOT_CONNECTED" || (state === "NO_DATA" && ever.n === 0) ? "—" : metric === "revenue" ? fmtMoney(r.v ?? 0, cur) : String(r.v ?? 0);
    return { key: metric, label, value, state, source };
  };

  const views = metricTile("views", "Views / reach", "analytics");
  const clicks = metricTile("clicks", "Affiliate clicks", "affiliate");
  const conv = metricTile("conversions", "Conversions", "affiliate");
  const revenue = metricTile("revenue", "Revenue", "affiliate");

  const opCost = q<{ v: number | null; n: number }>("SELECT SUM(amount) v, COUNT(*) n FROM costs WHERE brand_id=? AND is_estimate=0 AND currency=? AND incurred_at > ?", brandId, cur, since);
  const aiCost = q<{ v: number | null; n: number }>("SELECT SUM(amount) v, COUNT(*) n FROM costs WHERE brand_id=? AND is_estimate=1 AND category='ai' AND incurred_at > ?", brandId, since);
  const failed = q<{ n: number }>("SELECT COUNT(*) n FROM jobs WHERE state='FAILED' AND finished_at > ? AND (brand_id=? OR brand_id IS NULL)", since, brandId).n;
  const recovered = q<{ n: number }>("SELECT COUNT(*) n FROM jobs WHERE state='COMPLETE' AND attempts > 1 AND finished_at > ? AND (brand_id=? OR brand_id IS NULL)", since, brandId).n;

  let profit: Tile;
  if (revenue.state === "MEASURED" || revenue.state === "STALE") {
    const rv = q<{ v: number | null }>("SELECT SUM(value) v FROM performance_observations WHERE brand_id=? AND metric='revenue' AND currency=? AND period_end > ?", brandId, cur, since).v ?? 0;
    const cost = (opCost.v ?? 0) + (aiCost.v ?? 0);
    profit = { key: "profit", label: "Profit", value: fmtMoney(rv - cost, cur), state: "PARTIAL", source: "Revenue minus recorded and estimated costs; unrecorded costs are not included" };
  } else {
    profit = { key: "profit", label: "Profit", value: "Not calculable", state: "NOT_CALCULABLE", source: "Revenue unknown — unknown values are never treated as zero" };
  }

  const tiles: Tile[] = [
    { key: "produced", label: "Content produced", value: String(produced), state: "MEASURED", source: "Revisions saved · local database" },
    {
      key: "published",
      label: "Published",
      value: pubReady || everPublished ? String(published) : "—",
      state: pubReady || everPublished ? "MEASURED" : "NOT_CONNECTED",
      source: pubReady ? "Confirmed receipts + manual evidence" : everPublished ? "Manual evidence only" : "No publishing destination",
    },
    views,
    clicks,
    conv,
    revenue,
    { key: "opcost", label: "Operating cost", value: fmtMoney(opCost.v ?? 0, cur), state: "PARTIAL", source: `${opCost.n} recorded entr${opCost.n === 1 ? "y" : "ies"} · may be incomplete` },
    {
      key: "aicost",
      label: "Est. AI cost",
      value: aiCost.n ? fmtMoney(aiCost.v ?? 0, cur) : "—",
      state: aiCost.n ? "ESTIMATED" : isCapabilityReady(CAP.AI) ? "NO_DATA" : "NOT_CONNECTED",
      source: aiCost.n ? "Token usage × configured prices" : isCapabilityReady(CAP.AI) ? "No AI calls since last check-in" : "No AI provider connected",
    },
    profit,
    { key: "jobs", label: "Jobs failed / recovered", value: `${failed} / ${recovered}`, state: "MEASURED", source: "Worker events" },
  ];
  return { since, firstSession: !last, tiles, currency: cur };
}

export interface DecisionItem {
  kind: "recommendation" | "approval" | "job";
  id: string;
  type: string;
  subjectId: string;
  title: string;
  reason: string;
  evidence: string[];
  upside: string;
  risks: string;
  confidence: string;
  sufficiency: string;
  href: string;
}

export function needsDecision(brandId: string): DecisionItem[] {
  const items: DecisionItem[] = [];
  for (const r of listOpenRecommendations(brandId)) {
    items.push({
      kind: "recommendation", id: r.id, type: r.type, subjectId: r.subject_id, title: r.title, reason: r.reason, evidence: recEvidence(r),
      upside: r.upside, risks: r.risks, confidence: r.confidence, sufficiency: r.data_sufficiency,
      href: r.subject_type === "content" ? `/pipeline/${r.subject_id}` : "/brand",
    });
  }
  for (const c of listContent(brandId).filter((c) => c.stage === "APPROVAL" && c.approval !== "APPROVED")) {
    const ed = editorialReadiness(c);
    items.push({
      kind: "approval", id: c.id, type: "APPROVAL", subjectId: c.id, title: `Approve “${c.title}” (revision ${c.revision_number})`,
      reason: ed.ok ? "QA and editorial review passed on this revision." : ed.reasons.join(" "),
      evidence: [`Stage APPROVAL · approval ${c.approval}`], upside: "Approval is required before READY and publication.",
      risks: "Approval binds to this exact revision, destination and offer.", confidence: "—", sufficiency: ed.ok ? "SUFFICIENT" : "PARTIAL",
      href: `/pipeline/${c.id}`,
    });
  }
  for (const j of listJobs({ states: ["NEEDS_ATTENTION"], brandId })) {
    items.push({
      kind: "job", id: j.id, type: "JOB", subjectId: j.id, title: `Job ${j.id} (${j.type}) needs attention`,
      reason: (() => { try { return JSON.parse(j.error_json ?? "{}").message ?? "Operator review required"; } catch { return "Operator review required"; } })(),
      evidence: [`Side effect: ${j.side_effect_state}`, `Attempts: ${j.attempts}`], upside: "", risks: "Retrying blindly could duplicate an external action.",
      confidence: "—", sufficiency: "—", href: `/system?job=${j.id}`,
    });
  }
  return items;
}

export interface NextAction {
  kind: "run" | "link" | "none";
  label: string;
  reason: string;
  href?: string;
  jobType?: string;
  contentId?: string;
  blockers: string[];
}

export function nextAction(brandId: string): NextAction {
  const brand = getBrand(brandId);
  if (isSystemPaused()) return { kind: "link", label: "Resume automation", reason: "All automation is paused.", href: "/system#automations", blockers: [] };
  const counts = jobCounts();
  if (counts.NEEDS_ATTENTION > 0) return { kind: "link", label: "Review jobs that need attention", reason: `${counts.NEEDS_ATTENTION} job(s) stopped for operator review.`, href: "/system#jobs", blockers: [] };
  const av = getAvatars(brandId)[0];
  if (brand.status !== "ACTIVE" && activationBlockers(brandId).length)
    return { kind: "link", label: "Approve the avatar configuration", reason: `${av?.name ?? "The avatar"} is ${av?.lifecycle_status ?? "missing"}. The brand cannot be activated before that.`, href: "/brand#avatar", blockers: activationBlockers(brandId) };
  if (brand.status === "DRAFT") return { kind: "link", label: "Activate the brand", reason: "The brand is DRAFT; AI and publishing jobs stay blocked until you activate it.", href: "/brand", blockers: [] };
  if (brand.status !== "ACTIVE") return { kind: "link", label: `Brand is ${brand.status}`, reason: "Jobs for this brand are not scheduled.", href: "/brand", blockers: [] };
  if (!isCapabilityReady(CAP.AI)) return { kind: "link", label: "Connect an AI provider", reason: "Research, scripting and editorial review are blocked until the AI provider passes a live test.", href: "/system#ai", blockers: [`${CAP.AI} is ${getIntegration(CAP.AI).state}`] };
  if (!budgetStatus(brandId).cap) return { kind: "link", label: "Set an AI spend cap", reason: "Paid jobs stay blocked without an explicit monthly cap.", href: "/system#automations", blockers: [] };
  if (!isCapabilityReady(CAP.RESEARCH)) return { kind: "link", label: "Connect research retrieval", reason: "Research needs live sources; a language model alone is not research.", href: "/system#data", blockers: [`${CAP.RESEARCH} is ${getIntegration(CAP.RESEARCH).state}`] };
  const items = listContent(brandId);
  const active = new Set(listJobs({ states: ["QUEUED", "RUNNING", "RETRYING", "BLOCKED"], brandId }).map((j) => `${j.type}:${j.content_id}`));
  const approval = items.find((c) => c.stage === "APPROVAL" && c.approval !== "APPROVED" && editorialReadiness(getContent(c.id)).ok);
  if (approval) return { kind: "link", label: `Review and approve “${approval.title}”`, reason: "It passed QA and editorial review.", href: `/pipeline/${approval.id}`, blockers: [] };
  const ready = items.find((c) => c.stage === "READY");
  if (ready) {
    if (!isCapabilityReady(CAP.PUBLISH)) return { kind: "link", label: "Connect WordPress", reason: `“${ready.title}” is READY but no publishing destination is connected. You can also record a manual publication.`, href: "/system#content", blockers: [] };
    return { kind: "link", label: `Publish “${ready.title}”`, reason: "It is READY with a bound approval.", href: `/pipeline/${ready.id}`, blockers: [] };
  }
  const script = items.find((c) => c.stage === "SCRIPT" && !active.has(`QA_EDITORIAL:${c.id}`));
  if (script) return { kind: "run", label: `Run QA on “${script.title}”`, reason: "Deterministic QA is the next gate.", jobType: "QA_DETERMINISTIC", contentId: script.id, blockers: [] };
  const researched = items.find((c) => c.stage === "RESEARCH" && c.research_status === "RESEARCHED" && !active.has(`SCRIPT:${c.id}`));
  if (researched) return { kind: "run", label: `Generate script for “${researched.title}”`, reason: "Research is complete with sources.", jobType: "SCRIPT", contentId: researched.id, blockers: [] };
  const idea = items.find((c) => (c.stage === "IDEA" || c.stage === "RESEARCH") && c.research_status === "UNRESEARCHED" && !active.has(`RESEARCH:${c.id}`));
  if (idea) return { kind: "run", label: `Research “${idea.title}”`, reason: "Unresearched idea; research gathers dated sources first.", jobType: "RESEARCH", contentId: idea.id, blockers: [] };
  const publishedNoData = items.some((c) => c.stage === "PUBLISHED") && !isCapabilityReady(CAP.ANALYTICS);
  if (publishedNoData) return { kind: "link", label: "Connect analytics or import a report", reason: "Published items cannot be measured yet.", href: "/system#content", blockers: [] };
  return { kind: "none", label: "", reason: "", blockers: [] };
}

export function attentionSummary(brandId: string): { quiet: boolean; message: string } {
  const decisions = needsDecision(brandId).length;
  const na = nextAction(brandId);
  const counts = jobCounts();
  const externalMissing = [CAP.AI, CAP.RESEARCH, CAP.PUBLISH, CAP.ANALYTICS].filter((c) => !isCapabilityReady(c));
  if (decisions === 0 && na.kind === "none" && counts.FAILED === 0 && counts.NEEDS_ATTENTION === 0 && externalMissing.length === 0)
    return { quiet: true, message: "Nothing else needs your attention." };
  const parts: string[] = [];
  const n = decisions + (na.kind !== "none" ? 1 : 0);
  if (n) parts.push(`${n} item${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you.`);
  if (counts.FAILED) parts.push(`${counts.FAILED} failed job(s) in SYSTEM.`);
  if (externalMissing.length) parts.push(`Monitoring is partial — ${externalMissing.length} required provider(s) not connected, so a quiet screen does not mean all clear.`);
  return { quiet: false, message: parts.join(" ") };
}

export function activityFeed(limit = 12) {
  return listAudit({ limit });
}
