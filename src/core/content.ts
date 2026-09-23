import fs from "node:fs";
import path from "node:path";
import { assetsDir, getDb, tx } from "./db";
import { audit } from "./audit";
import { commercialHash, commercialReadiness } from "./commercial";
import { capabilityBlockReason, isCapabilityReady } from "./integrations";
import { createJob } from "./jobs";
import { latestQa, runDeterministicQa, saveQaReport } from "./qa";
import { allowHumanEditorialReview } from "./settings";
import {
  type ApprovalState,
  CLAIM_TYPES,
  type ClaimType,
  FACT_STATUSES,
  type FactStatus,
  HIGH_RISK_CLAIMS,
  INTENTS,
  type Intent,
  RISKS,
  type Risk,
  STAGES,
  type Stage,
} from "./types";
import { AppError, assert, newId, nowIso, sha256 } from "./util";

export interface ContentRow {
  id: string;
  brand_id: string;
  title: string;
  content_type: string;
  pillar_id: string | null;
  stage: Stage;
  buyer_intent: Intent | null;
  risk: Risk;
  target_offer_id: string | null;
  commercial_decision: "UNDECIDED" | "OFFER" | "NO_OFFER";
  destination: string;
  current_revision_id: string;
  research_status: "UNRESEARCHED" | "IN_PROGRESS" | "RESEARCHED";
  legacy: number;
  verification_status: "VERIFIED" | "UNVERIFIED";
  origin_id: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface RevisionRow {
  id: string;
  content_id: string;
  number: number;
  title: string;
  body: string;
  research_notes: string;
  change_note: string;
  author: string;
  job_id: string | null;
  hash: string;
  created_at: string;
}
export interface EvidenceRow {
  id: string;
  brand_id: string;
  content_id: string | null;
  program_id: string | null;
  kind: string;
  url: string | null;
  title: string;
  excerpt: string;
  checked_at: string | null;
  file_path: string | null;
  sha256: string | null;
  status: FactStatus;
  provenance_json: string;
  created_by: string;
  created_at: string;
}
export interface ClaimRow {
  id: string;
  content_id: string;
  text: string;
  claim_type: ClaimType;
  status: FactStatus;
  evidence_id: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}
export interface ApprovalRow {
  id: string;
  subject_type: string;
  subject_id: string;
  revision_id: string | null;
  destination: string | null;
  commercial_hash: string | null;
  decision: "APPROVED" | "REJECTED";
  status: "ACTIVE" | "INVALIDATED" | "EXPIRED" | "SUPERSEDED";
  level: number;
  policy_version: number | null;
  actor: string;
  note: string;
  legacy: number;
  created_at: string;
  expires_at: string | null;
  invalidated_at: string | null;
  invalidated_reason: string | null;
}
export interface PublicationRow {
  id: string;
  content_id: string;
  revision_id: string;
  approval_id: string;
  destination: string;
  remote_id: string | null;
  remote_url: string | null;
  status: "CONFIRMED" | "MANUAL_CONFIRMED" | "AMBIGUOUS" | "FAILED" | "WITHDRAWN";
  evidence_id: string | null;
  receipt_json: string;
  job_id: string | null;
  created_at: string;
}

export const MIN_SCRIPT_CHARS = 200;

/* ---------------------------------------------------------------- reads */

export function getContent(id: string): ContentRow {
  const c = getDb().prepare("SELECT * FROM content_items WHERE id = ?").get(id) as ContentRow | undefined;
  if (!c) throw new AppError("NOT_FOUND", `Content ${id} not found`, 404);
  return c;
}

export function getRevision(id: string): RevisionRow {
  const r = getDb().prepare("SELECT * FROM content_revisions WHERE id = ?").get(id) as RevisionRow | undefined;
  if (!r) throw new AppError("NOT_FOUND", `Revision ${id} not found`, 404);
  return r;
}

export function listRevisions(contentId: string): RevisionRow[] {
  return getDb().prepare("SELECT * FROM content_revisions WHERE content_id = ? ORDER BY number DESC").all(contentId) as RevisionRow[];
}
export function listEvidence(contentId: string): EvidenceRow[] {
  return getDb().prepare("SELECT * FROM evidence WHERE content_id = ? ORDER BY created_at DESC").all(contentId) as EvidenceRow[];
}
export function listClaims(contentId: string): ClaimRow[] {
  return getDb().prepare("SELECT * FROM claims WHERE content_id = ? ORDER BY created_at").all(contentId) as ClaimRow[];
}
export function listApprovals(subjectType: string, subjectId: string): ApprovalRow[] {
  return getDb().prepare("SELECT * FROM approvals WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC").all(subjectType, subjectId) as ApprovalRow[];
}
export function listPublications(contentId: string): PublicationRow[] {
  return getDb().prepare("SELECT * FROM publications WHERE content_id = ? ORDER BY created_at DESC").all(contentId) as PublicationRow[];
}

export function activeContentApproval(item: ContentRow): ApprovalRow | undefined {
  const a = getDb()
    .prepare(
      "SELECT * FROM approvals WHERE subject_type='content' AND subject_id=? AND status='ACTIVE' AND decision='APPROVED' AND revision_id=? AND destination=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(item.id, item.current_revision_id, item.destination) as ApprovalRow | undefined;
  if (!a) return undefined;
  if (a.commercial_hash !== commercialHash(item)) return undefined;
  if (a.expires_at && a.expires_at < nowIso()) return undefined;
  return a;
}

export function approvalState(item: ContentRow): ApprovalState {
  if (activeContentApproval(item)) return "APPROVED";
  const rows = listApprovals("content", item.id);
  const cur = rows.find((a) => a.revision_id === item.current_revision_id);
  if (cur?.decision === "REJECTED") return "REJECTED";
  if (item.stage === "APPROVAL") return rows.some((a) => a.status === "INVALIDATED" || a.status === "EXPIRED") ? "EXPIRED" : "PENDING";
  if (["READY", "PUBLISHED", "MEASURE"].includes(item.stage)) return rows.length ? "EXPIRED" : "PENDING";
  if (rows.some((a) => a.status === "INVALIDATED")) return "EXPIRED";
  return "NOT_REQUIRED";
}

export interface ListFilters {
  q?: string;
  pillarId?: string;
  intent?: string;
  risk?: string;
  approval?: string;
  includeRetired?: boolean;
}

export function listContent(brandId: string, f: ListFilters = {}): (ContentRow & { approval: ApprovalState; revision_number: number })[] {
  const where = ["c.brand_id = ?"];
  const args: unknown[] = [brandId];
  if (!f.includeRetired) where.push("c.retired_at IS NULL");
  if (f.q) {
    where.push("(c.id LIKE ? OR c.title LIKE ? OR EXISTS (SELECT 1 FROM claims k WHERE k.content_id = c.id AND k.text LIKE ?))");
    args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  if (f.pillarId) {
    where.push("c.pillar_id = ?");
    args.push(f.pillarId);
  }
  if (f.intent) {
    if (f.intent === "UNSET") where.push("c.buyer_intent IS NULL");
    else {
      where.push("c.buyer_intent = ?");
      args.push(f.intent);
    }
  }
  if (f.risk) {
    where.push("c.risk = ?");
    args.push(f.risk);
  }
  const rows = getDb()
    .prepare(
      `SELECT c.*, r.number revision_number FROM content_items c LEFT JOIN content_revisions r ON r.id = c.current_revision_id
       WHERE ${where.join(" AND ")} ORDER BY c.created_at`,
    )
    .all(...args) as (ContentRow & { revision_number: number })[];
  const out = rows.map((r) => ({ ...r, approval: approvalState(r) }));
  return f.approval ? out.filter((r) => r.approval === f.approval) : out;
}

/* ------------------------------------------------------------- readiness */

export interface Readiness {
  editorial: { ok: boolean; state: string; reasons: string[] };
  commercial: { ok: boolean; state: string; reasons: string[] };
  publication: { ok: boolean; state: string; reasons: string[] };
  measurement: { ok: boolean; state: string; reasons: string[] };
}

export function editorialReadiness(item: ContentRow): { ok: boolean; reasons: string[]; state: string } {
  const reasons: string[] = [];
  const det = latestQa(item.id, item.current_revision_id, "DETERMINISTIC");
  if (!det) reasons.push("Deterministic QA has not run on the current revision.");
  else if (det.result === "FAIL") reasons.push("Deterministic QA failed on the current revision.");
  const ai = latestQa(item.id, item.current_revision_id, "AI_EDITORIAL");
  const human = latestQa(item.id, item.current_revision_id, "HUMAN_REVIEW");
  const editorialPass = (ai && ai.result !== "FAIL") || (allowHumanEditorialReview() && human && human.result !== "FAIL");
  if (!editorialPass) {
    if (ai?.result === "FAIL") reasons.push("AI editorial review failed.");
    else if (human?.result === "FAIL") reasons.push("Human editorial review failed.");
    else reasons.push(allowHumanEditorialReview() ? "Needs AI editorial review or a recorded human review." : "Needs AI editorial review.");
  }
  const blockers = listClaims(item.id).filter(
    (c) => c.status === "BLOCKED" || (c.status === "UNVERIFIED" && (HIGH_RISK_CLAIMS as string[]).includes(c.claim_type)),
  );
  if (blockers.length) reasons.push(`${blockers.length} unresolved safety/compatibility claim(s).`);
  if (item.risk === "BLOCKED") reasons.push("Item risk is BLOCKED.");
  const state = reasons.length === 0 ? "CLEARED" : !det ? "QA_NOT_RUN" : "BLOCKED";
  return { ok: reasons.length === 0, reasons, state };
}

export function readiness(item: ContentRow): Readiness {
  const ed = editorialReadiness(item);
  const cm = commercialReadiness(item);
  const pubs = listPublications(item.id).filter((p) => p.status === "CONFIRMED" || p.status === "MANUAL_CONFIRMED");
  const pubReasons: string[] = [];
  const pubBlock = capabilityBlockReason("publish.primary");
  if (pubs.length === 0) {
    if (pubBlock) pubReasons.push(`Publishing destination not ready: ${pubBlock}`);
    if (!activeContentApproval(item)) pubReasons.push("No approval bound to the current revision and destination.");
  }
  const obs = getDb().prepare("SELECT COUNT(*) n, MAX(observed_at) last FROM performance_observations WHERE content_id = ?").get(item.id) as { n: number; last: string | null };
  const measReasons: string[] = [];
  if (!pubs.length) measReasons.push("Available only after confirmed publication.");
  else if (!isCapabilityReady("analytics.primary") && obs.n === 0) measReasons.push("No analytics source connected and no imported data.");
  return {
    editorial: ed,
    commercial: { ok: cm.ok, reasons: cm.reasons, state: cm.ok ? "CLEARED" : "BLOCKED" },
    publication: {
      ok: pubs.length > 0,
      reasons: pubReasons,
      state: pubs.length ? pubs[0].status : pubBlock ? "NOT_CONNECTED" : "NOT_PUBLISHED",
    },
    measurement: {
      ok: obs.n > 0,
      reasons: measReasons,
      state: obs.n > 0 ? "MEASURED" : pubs.length ? (isCapabilityReady("analytics.primary") ? "NO_DATA" : "NOT_CONNECTED") : "NO_DATA",
    },
  };
}

/* ----------------------------------------------------------- mutations */

function revHash(title: string, body: string) {
  return sha256(`${title}\n${body}`);
}

export function createContent(
  brandId: string,
  i: { title: string; contentType?: string; pillarId?: string | null; buyerIntent?: Intent | null; risk?: Risk; body?: string; legacy?: boolean; id?: string },
  actor: string,
): string {
  assert(i.title.trim().length >= 3, "BAD_INPUT", "Title is required (3+ characters).");
  if (i.buyerIntent) assert(INTENTS.includes(i.buyerIntent), "BAD_INPUT", "Unknown buyer intent.");
  if (i.risk) assert(RISKS.includes(i.risk), "BAD_INPUT", "Unknown risk.");
  if (i.pillarId) {
    const p = getDb().prepare("SELECT brand_id FROM pillars WHERE id = ?").get(i.pillarId) as { brand_id: string } | undefined;
    assert(p && p.brand_id === brandId, "BAD_INPUT", "Pillar belongs to another brand.");
  }
  const id = i.id ?? newId("content");
  const rid = newId("rev");
  const now = nowIso();
  tx(() => {
    getDb()
      .prepare(
        `INSERT INTO content_items (id, brand_id, title, content_type, pillar_id, stage, buyer_intent, risk, current_revision_id, legacy, verification_status, created_at, updated_at)
         VALUES (?,?,?,?,?, 'IDEA', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, brandId, i.title.trim(), i.contentType ?? "article", i.pillarId ?? null, i.buyerIntent ?? null, i.risk ?? "MEDIUM", rid, i.legacy ? 1 : 0, i.legacy ? "UNVERIFIED" : "VERIFIED", now, now);
    getDb()
      .prepare("INSERT INTO content_revisions (id, content_id, number, title, body, change_note, author, hash, created_at) VALUES (?,?,1,?,?,?,?,?,?)")
      .run(rid, id, i.title.trim(), i.body ?? "", "Created", actor, revHash(i.title.trim(), i.body ?? ""), now);
  });
  audit({ actor, action: "content.create", subjectType: "content", subjectId: id, brandId, summary: `Content ${id} “${i.title.trim()}” created in IDEA` });
  return id;
}

function invalidateContentApprovals(contentId: string, reason: string, keepRevisionId?: string) {
  const r = getDb()
    .prepare(
      `UPDATE approvals SET status='INVALIDATED', invalidated_at=?, invalidated_reason=?
       WHERE subject_type='content' AND subject_id=? AND status='ACTIVE' ${keepRevisionId ? "AND revision_id != ?" : ""}`,
    )
    .run(...([nowIso(), reason, contentId].concat(keepRevisionId ? [keepRevisionId] : []) as unknown[]));
  return r.changes;
}

/** Material edits create a new revision; approvals bound to older revisions are invalidated. */
export function saveRevision(
  contentId: string,
  i: { title?: string; body?: string; researchNotes?: string; changeNote?: string },
  actor: string,
  jobId?: string | null,
): { revisionId: string; number: number; invalidated: number } {
  const item = getContent(contentId);
  assert(!item.retired_at, "RETIRED", "Content is retired; restore it before editing.");
  const cur = getRevision(item.current_revision_id);
  const title = (i.title ?? cur.title).trim();
  const body = i.body ?? cur.body;
  const notes = i.researchNotes ?? cur.research_notes;
  assert(title.length >= 3, "BAD_INPUT", "Title is required.");
  if (title === cur.title && body === cur.body && notes === cur.research_notes) return { revisionId: cur.id, number: cur.number, invalidated: 0 };
  const rid = newId("rev");
  const now = nowIso();
  let invalidated = 0;
  const back = ["QA", "APPROVAL", "READY"].includes(item.stage);
  tx(() => {
    getDb()
      .prepare("INSERT INTO content_revisions (id, content_id, number, title, body, research_notes, change_note, author, job_id, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(rid, contentId, cur.number + 1, title, body, notes, i.changeNote ?? "", actor, jobId ?? null, revHash(title, body), now);
    getDb()
      .prepare(`UPDATE content_items SET current_revision_id=?, title=?, stage=?, updated_at=? WHERE id=?`)
      .run(rid, title, back ? "SCRIPT" : item.stage, now, contentId);
    invalidated = invalidateContentApprovals(contentId, `Superseded by revision ${cur.number + 1}`);
  });
  audit({
    actor,
    action: "content.revise",
    subjectType: "content",
    subjectId: contentId,
    brandId: item.brand_id,
    summary: `${contentId} revision ${cur.number + 1} saved${invalidated ? `; ${invalidated} approval(s) invalidated` : ""}${back ? "; returned to SCRIPT for QA" : ""}`,
  });
  return { revisionId: rid, number: cur.number + 1, invalidated };
}

export function updateContentMeta(
  contentId: string,
  p: {
    pillarId?: string | null;
    contentType?: string;
    buyerIntent?: Intent | null;
    risk?: Risk;
    targetOfferId?: string | null;
    commercialDecision?: ContentRow["commercial_decision"];
    destination?: string;
  },
  actor: string,
) {
  const item = getContent(contentId);
  if (p.buyerIntent) assert(INTENTS.includes(p.buyerIntent), "BAD_INPUT", "Unknown buyer intent.");
  if (p.risk) assert(RISKS.includes(p.risk), "BAD_INPUT", "Unknown risk.");
  if (p.commercialDecision) assert(["UNDECIDED", "OFFER", "NO_OFFER"].includes(p.commercialDecision), "BAD_INPUT", "Unknown commercial decision.");
  if (p.targetOfferId) {
    const o = getDb().prepare("SELECT brand_id FROM offers WHERE id = ?").get(p.targetOfferId) as { brand_id: string } | undefined;
    assert(o && o.brand_id === item.brand_id, "BAD_INPUT", "Offer belongs to another brand.");
  }
  const next = {
    pillar_id: p.pillarId !== undefined ? p.pillarId : item.pillar_id,
    content_type: p.contentType ?? item.content_type,
    buyer_intent: p.buyerIntent !== undefined ? p.buyerIntent : item.buyer_intent,
    risk: p.risk ?? item.risk,
    target_offer_id: p.targetOfferId !== undefined ? p.targetOfferId : item.target_offer_id,
    commercial_decision: p.commercialDecision ?? (p.targetOfferId ? "OFFER" : item.commercial_decision),
    destination: p.destination ?? item.destination,
  };
  if (next.commercial_decision === "NO_OFFER") next.target_offer_id = null;
  const commercialChanged =
    next.target_offer_id !== item.target_offer_id || next.commercial_decision !== item.commercial_decision || next.destination !== item.destination;
  tx(() => {
    getDb()
      .prepare("UPDATE content_items SET pillar_id=?, content_type=?, buyer_intent=?, risk=?, target_offer_id=?, commercial_decision=?, destination=?, updated_at=? WHERE id=?")
      .run(next.pillar_id, next.content_type, next.buyer_intent, next.risk, next.target_offer_id, next.commercial_decision, next.destination, nowIso(), contentId);
    if (commercialChanged) {
      const n = invalidateContentApprovals(contentId, "Commercial configuration or destination changed");
      if (n && item.stage === "READY") getDb().prepare("UPDATE content_items SET stage='APPROVAL' WHERE id=?").run(contentId);
    }
  });
  audit({ actor, action: "content.meta", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `${contentId} details updated${commercialChanged ? " (commercial change — approvals re-checked)" : ""}` });
}

/* ---------------------------------------------------------- transitions */

export function checkTransition(item: ContentRow, target: Stage): string[] {
  const from = STAGES.indexOf(item.stage);
  const to = STAGES.indexOf(target);
  if (to < 0) return [`Unknown stage ${target}.`];
  if (item.retired_at) return ["Content is retired."];
  if (to === from) return ["Already in that stage."];
  if (to < from) {
    if (from >= STAGES.indexOf("PUBLISHED")) return ["Published content cannot move back; retire it or create a new item."];
    return [];
  }
  if (to !== from + 1) return [`Stages advance one at a time (${item.stage} → ${STAGES[from + 1]}).`];
  const rev = getRevision(item.current_revision_id);
  switch (target) {
    case "RESEARCH":
      return [];
    case "SCRIPT": {
      const n = (getDb().prepare("SELECT COUNT(*) n FROM evidence WHERE content_id=? AND checked_at IS NOT NULL AND kind != 'PUBLICATION_PROOF'").get(item.id) as { n: number }).n;
      return n > 0 || item.research_status === "RESEARCHED" ? [] : ["Attach at least one dated source, or run GENERATE RESEARCH."];
    }
    case "QA":
      return rev.body.trim().length >= MIN_SCRIPT_CHARS ? [] : [`The current revision needs a script of at least ${MIN_SCRIPT_CHARS} characters.`];
    case "APPROVAL":
      return editorialReadiness(item).reasons;
    case "READY": {
      const r: string[] = [];
      if (!activeContentApproval(item)) r.push("Needs an approval bound to the current revision, destination and commercial configuration.");
      r.push(...commercialReadiness(item).reasons);
      return r;
    }
    case "PUBLISHED":
      return ["PUBLISHED requires a confirmed provider receipt or an evidence-backed manual publication. Use PUBLISH or RECORD MANUAL PUBLICATION."];
    case "MEASURE": {
      const n = (getDb().prepare("SELECT COUNT(*) n FROM performance_observations WHERE content_id=?").get(item.id) as { n: number }).n;
      return n > 0 || isCapabilityReady("analytics.primary") ? [] : ["No analytics source is connected and no performance data has been imported."];
    }
  }
  return ["Transition not allowed."];
}

export function moveStage(contentId: string, target: Stage, actor: string, note = "") {
  const item = getContent(contentId);
  const reasons = checkTransition(item, target);
  if (reasons.length) throw new AppError("TRANSITION_BLOCKED", reasons.join(" "), 409, reasons);
  getDb().prepare("UPDATE content_items SET stage=?, updated_at=? WHERE id=?").run(target, nowIso(), contentId);
  audit({
    actor,
    action: "content.stage",
    subjectType: "content",
    subjectId: contentId,
    brandId: item.brand_id,
    summary: `${contentId}: ${item.stage} → ${target}${note ? ` (${note})` : ""}`,
  });
}

export function returnForRevision(contentId: string, actor: string, note: string) {
  assert(note.trim().length >= 3, "BAD_INPUT", "Say what needs revising.");
  const item = getContent(contentId);
  assert(STAGES.indexOf(item.stage) > STAGES.indexOf("SCRIPT") && STAGES.indexOf(item.stage) <= STAGES.indexOf("READY"), "BAD_STATE", `Cannot return from ${item.stage}.`);
  moveStage(contentId, "SCRIPT", actor, `Returned for revision: ${note.trim()}`);
}

export function retireContent(contentId: string, actor: string) {
  const item = getContent(contentId);
  getDb().prepare("UPDATE content_items SET retired_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), contentId);
  audit({ actor, action: "content.retire", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `${contentId} retired (reversible)` });
}

export function restoreContent(contentId: string, actor: string) {
  const item = getContent(contentId);
  getDb().prepare("UPDATE content_items SET retired_at=NULL, updated_at=? WHERE id=?").run(nowIso(), contentId);
  audit({ actor, action: "content.restore", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `${contentId} restored` });
}

/* ------------------------------------------------------ evidence/claims */

export function addEvidence(
  i: {
    brandId: string;
    contentId?: string | null;
    programId?: string | null;
    kind: "WEB_SOURCE" | "DOCUMENT" | "MANUAL_NOTE" | "PUBLICATION_PROOF" | "DRIVE_DOCUMENT";
    url?: string | null;
    title: string;
    excerpt?: string;
    checkedAt?: string | null;
    status?: FactStatus;
    file?: { name: string; data: Buffer };
    provenance?: unknown;
  },
  actor: string,
): string {
  assert(i.title.trim().length > 0, "BAD_INPUT", "Evidence needs a title.");
  if (i.url) {
    try {
      const u = new URL(i.url);
      assert(u.protocol === "https:" || u.protocol === "http:", "BAD_URL", "Evidence URL must be http(s).");
    } catch {
      throw new AppError("BAD_URL", "Evidence URL is not valid.");
    }
  }
  if (i.status) assert(FACT_STATUSES.includes(i.status), "BAD_INPUT", "Unknown status.");
  const id = newId("evidence");
  let filePath: string | null = null;
  let hash: string | null = null;
  if (i.file) {
    assert(i.file.data.length <= 25 * 1024 * 1024, "TOO_LARGE", "Files are limited to 25 MB.");
    const safe = i.file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const rel = path.join("evidence", `${id}_${safe}`);
    fs.mkdirSync(path.join(assetsDir(), "evidence"), { recursive: true });
    fs.writeFileSync(path.join(assetsDir(), rel), i.file.data);
    filePath = rel.split(path.sep).join("/");
    hash = sha256(i.file.data);
  }
  getDb()
    .prepare(
      `INSERT INTO evidence (id, brand_id, content_id, program_id, kind, url, title, excerpt, checked_at, file_path, sha256, status, provenance_json, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      i.brandId,
      i.contentId ?? null,
      i.programId ?? null,
      i.kind,
      i.url ?? null,
      i.title.trim(),
      i.excerpt ?? "",
      i.checkedAt ? new Date(i.checkedAt).toISOString() : null,
      filePath,
      hash,
      i.status ?? "UNVERIFIED",
      JSON.stringify(i.provenance ?? { addedBy: actor }),
      actor,
      nowIso(),
    );
  audit({ actor, action: "evidence.add", subjectType: i.contentId ? "content" : "brand", subjectId: i.contentId ?? i.brandId, brandId: i.brandId, summary: `Evidence “${i.title.trim()}” attached${i.contentId ? ` to ${i.contentId}` : ""}` });
  return id;
}

export function addClaim(contentId: string, i: { text: string; claimType: ClaimType; status?: FactStatus; evidenceId?: string | null; note?: string }, actor: string) {
  const item = getContent(contentId);
  assert(i.text.trim().length >= 5, "BAD_INPUT", "Claim text is required.");
  assert(CLAIM_TYPES.includes(i.claimType), "BAD_INPUT", "Unknown claim type.");
  const id = newId("claim");
  getDb()
    .prepare("INSERT INTO claims (id, content_id, text, claim_type, status, evidence_id, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, contentId, i.text.trim(), i.claimType, "UNVERIFIED", null, i.note ?? "", nowIso(), nowIso());
  if (i.status && i.status !== "UNVERIFIED") setClaimStatus(id, i.status, i.evidenceId ?? null, actor, i.note);
  audit({ actor, action: "claim.add", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `${i.claimType} claim recorded on ${contentId}` });
  return id;
}

export function setClaimStatus(claimId: string, status: FactStatus, evidenceId: string | null, actor: string, note?: string) {
  const c = getDb().prepare("SELECT * FROM claims WHERE id = ?").get(claimId) as ClaimRow | undefined;
  if (!c) throw new AppError("NOT_FOUND", "Claim not found", 404);
  assert(FACT_STATUSES.includes(status), "BAD_INPUT", "Unknown status.");
  if (status === "VERIFIED") {
    assert(evidenceId, "EVIDENCE_REQUIRED", "A verified claim must cite evidence.");
    const e = getDb().prepare("SELECT * FROM evidence WHERE id = ?").get(evidenceId) as EvidenceRow | undefined;
    assert(e && e.content_id === c.content_id, "EVIDENCE_REQUIRED", "Evidence must be attached to the same content.");
    if ((HIGH_RISK_CLAIMS as string[]).includes(c.claim_type)) {
      assert(e.url && e.checked_at, "EVIDENCE_REQUIRED", `${c.claim_type} claims need a source URL and a checked date.`);
    }
  }
  getDb().prepare("UPDATE claims SET status=?, evidence_id=?, note=COALESCE(?, note), updated_at=? WHERE id=?").run(status, evidenceId, note ?? null, nowIso(), claimId);
  audit({ actor, action: "claim.status", subjectType: "content", subjectId: c.content_id, summary: `Claim ${claimId} → ${status}` });
}

/* ------------------------------------------------------------ QA/approval */

export function runQaNow(contentId: string, actor: string) {
  const item = getContent(contentId);
  const r = runDeterministicQa(contentId);
  const id = saveQaReport({ contentId, revisionId: r.revisionId, kind: "DETERMINISTIC", result: r.result, findings: r.findings, reviewer: "deterministic-rules" });
  if (item.stage === "SCRIPT" && checkTransition(item, "QA").length === 0) {
    getDb().prepare("UPDATE content_items SET stage='QA', updated_at=? WHERE id=?").run(nowIso(), contentId);
  }
  audit({ actor, action: "qa.deterministic", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `Deterministic QA on ${contentId}: ${r.result} (structural only — not a factual or medical review)` });
  return { reportId: id, ...r };
}

export function recordHumanReview(contentId: string, result: "PASS" | "FAIL", notes: string, actor: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Human review must be recorded by the operator.", 403);
  if (!allowHumanEditorialReview()) throw new AppError("NOT_PERMITTED", "The human review route is disabled in SYSTEM settings.", 403);
  assert(notes.trim().length >= 10, "BAD_INPUT", "Describe what you reviewed (facts, claims, medical boundary).");
  const item = getContent(contentId);
  const id = saveQaReport({ contentId, revisionId: item.current_revision_id, kind: "HUMAN_REVIEW", result, findings: [{ check: "human_review", severity: result, message: notes.trim() }], reviewer: actor });
  audit({ actor, action: "qa.human", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `Human editorial review recorded on ${contentId}: ${result}` });
  return id;
}

export function approveContent(contentId: string, actor: string, note = "", expectedRevisionId?: string): string {
  if (actor !== "operator") throw new AppError("PERMISSION", "Content approval is a human action (Level 4).", 403);
  const item = getContent(contentId);
  if (expectedRevisionId && expectedRevisionId !== item.current_revision_id)
    throw new AppError("STALE_REVISION", "The content changed since you opened it. Review the current revision first.", 409);
  assert(item.stage === "APPROVAL", "BAD_STATE", `Content is in ${item.stage}; approval happens in APPROVAL.`);
  const ed = editorialReadiness(item);
  if (!ed.ok) throw new AppError("NOT_APPROVABLE", ed.reasons.join(" "), 409, ed.reasons);
  const id = newId("approval");
  tx(() => {
    getDb()
      .prepare("UPDATE approvals SET status='SUPERSEDED' WHERE subject_type='content' AND subject_id=? AND status='ACTIVE'")
      .run(contentId);
    getDb()
      .prepare(
        `INSERT INTO approvals (id, subject_type, subject_id, revision_id, destination, commercial_hash, decision, status, level, actor, note, created_at)
         VALUES (?, 'content', ?, ?, ?, ?, 'APPROVED', 'ACTIVE', 4, ?, ?, ?)`,
      )
      .run(id, contentId, item.current_revision_id, item.destination, commercialHash(item), actor, note, nowIso());
  });
  const rev = getRevision(item.current_revision_id);
  audit({ actor, action: "content.approve", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `${contentId} revision ${rev.number} approved for ${item.destination}` });
  return id;
}

export function rejectContent(contentId: string, actor: string, note: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator rejects content.", 403);
  assert(note.trim().length >= 3, "BAD_INPUT", "Give a reason for rejecting.");
  const item = getContent(contentId);
  assert(item.stage === "APPROVAL" || item.stage === "READY", "BAD_STATE", `Content is in ${item.stage}.`);
  tx(() => {
    getDb().prepare("UPDATE approvals SET status='SUPERSEDED' WHERE subject_type='content' AND subject_id=? AND status='ACTIVE'").run(contentId);
    getDb()
      .prepare(
        `INSERT INTO approvals (id, subject_type, subject_id, revision_id, destination, commercial_hash, decision, status, level, actor, note, created_at)
         VALUES (?, 'content', ?, ?, ?, ?, 'REJECTED', 'ACTIVE', 4, ?, ?, ?)`,
      )
      .run(newId("approval"), contentId, item.current_revision_id, item.destination, commercialHash(item), actor, note.trim(), nowIso());
    getDb().prepare("UPDATE content_items SET stage='SCRIPT', updated_at=? WHERE id=?").run(nowIso(), contentId);
  });
  audit({ actor, action: "content.reject", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `${contentId} rejected: ${note.trim()}` });
}

/* ---------------------------------------------------------- publication */

export function publishGaps(item: ContentRow): string[] {
  const r: string[] = [];
  if (item.stage !== "READY") r.push(`Content is in ${item.stage}, not READY.`);
  if (!activeContentApproval(item)) r.push("No active approval for the current revision, destination and commercial configuration.");
  r.push(...commercialReadiness(item).reasons);
  if (item.risk === "BLOCKED") r.push("Risk is BLOCKED.");
  return r;
}

export function requestPublish(contentId: string, actor: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Initial publication requires the operator (explicit approval).", 403);
  const item = getContent(contentId);
  const gaps = publishGaps(item);
  if (gaps.length) throw new AppError("PUBLISH_BLOCKED", gaps.join(" "), 409, gaps);
  const approval = activeContentApproval(item)!;
  return createJob({
    type: "PUBLISH",
    brandId: item.brand_id,
    contentId,
    revisionId: item.current_revision_id,
    approvalId: approval.id,
    actor,
    input: { destination: item.destination },
    idempotencyKey: `PUBLISH:${contentId}:${item.current_revision_id}:${approval.id}`,
  });
}

/** Records a publication confirmed by the provider (called by the publish module). */
export function recordProviderPublication(i: {
  contentId: string;
  revisionId: string;
  approvalId: string;
  destination: string;
  remoteId: string;
  remoteUrl: string;
  receipt: unknown;
  jobId: string;
}): string {
  assert(i.remoteId && i.remoteUrl, "BAD_RECEIPT", "A publication needs a remote ID and URL.");
  const item = getContent(i.contentId);
  const existing = getDb().prepare("SELECT id FROM publications WHERE content_id=? AND revision_id=? AND remote_id=?").get(i.contentId, i.revisionId, i.remoteId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId("pub");
  tx(() => {
    getDb()
      .prepare(
        `INSERT INTO publications (id, content_id, revision_id, approval_id, destination, remote_id, remote_url, status, receipt_json, job_id, created_at)
         VALUES (?,?,?,?,?,?,?, 'CONFIRMED', ?, ?, ?)`,
      )
      .run(id, i.contentId, i.revisionId, i.approvalId, i.destination, i.remoteId, i.remoteUrl, JSON.stringify(i.receipt), i.jobId, nowIso());
    getDb().prepare("UPDATE content_items SET stage='PUBLISHED', updated_at=? WHERE id=?").run(nowIso(), i.contentId);
  });
  audit({ actor: "worker", action: "content.published", subjectType: "content", subjectId: i.contentId, brandId: item.brand_id, summary: `${i.contentId} published: ${i.remoteUrl}` });
  return id;
}

/** Manual publication requires READY, a bound approval and evidence (URL + proof note or file). */
export function recordManualPublication(contentId: string, i: { url: string; proofNote: string; file?: { name: string; data: Buffer } }, actor: string): string {
  if (actor !== "operator") throw new AppError("PERMISSION", "Manual publication is recorded by the operator.", 403);
  const item = getContent(contentId);
  const gaps = publishGaps(item);
  if (gaps.length) throw new AppError("PUBLISH_BLOCKED", gaps.join(" "), 409, gaps);
  assert(i.proofNote.trim().length >= 10 || i.file, "EVIDENCE_REQUIRED", "Describe how you confirmed the page is live, or attach a screenshot.");
  const approval = activeContentApproval(item)!;
  const evId = addEvidence(
    { brandId: item.brand_id, contentId, kind: "PUBLICATION_PROOF", url: i.url, title: `Manual publication proof`, excerpt: i.proofNote.trim(), checkedAt: nowIso(), status: "VERIFIED", file: i.file },
    actor,
  );
  const id = newId("pub");
  tx(() => {
    getDb()
      .prepare(
        `INSERT INTO publications (id, content_id, revision_id, approval_id, destination, remote_id, remote_url, status, evidence_id, receipt_json, created_at)
         VALUES (?,?,?,?,?, NULL, ?, 'MANUAL_CONFIRMED', ?, ?, ?)`,
      )
      .run(id, contentId, item.current_revision_id, approval.id, item.destination, i.url, evId, JSON.stringify({ manual: true, by: actor }), nowIso());
    getDb().prepare("UPDATE content_items SET stage='PUBLISHED', updated_at=? WHERE id=?").run(nowIso(), contentId);
  });
  audit({ actor, action: "content.published_manual", subjectType: "content", subjectId: contentId, brandId: item.brand_id, summary: `${contentId} manually published (evidence ${evId}): ${i.url}` });
  return id;
}

export function exportContent(contentId: string) {
  const item = getContent(contentId);
  return {
    schema: "omos.content.v1",
    exported_at: nowIso(),
    item,
    revisions: listRevisions(contentId),
    evidence: listEvidence(contentId),
    claims: listClaims(contentId),
    approvals: listApprovals("content", contentId),
    qa: getDb().prepare("SELECT * FROM qa_reports WHERE content_id = ?").all(contentId),
    publications: listPublications(contentId),
  };
}

export { STAGES };
