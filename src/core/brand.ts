import { getDb, tx } from "./db";
import { audit } from "./audit";
import { getSetting, setSetting } from "./settings";
import { type BrandStatus, BRAND_STATUSES } from "./types";
import { AppError, assert, newId, nowIso, parseJson } from "./util";

export interface BrandRow {
  id: string;
  name: string;
  status: BrandStatus;
  market: string;
  language: string;
  currency: string;
  objective: string;
  description: string;
  settings_json: string;
  origin_id: string | null;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}
export interface PillarRow {
  id: string;
  brand_id: string;
  name: string;
  sort: number;
}
export interface AvatarRow {
  id: string;
  brand_id: string;
  name: string;
  role: string;
  bio: string;
  personality: string;
  voice_tone: string;
  ai_disclosure: string;
  expertise_boundary: string;
  restricted_claims_json: string;
  visual_ref: string;
  voice_ref: string;
  lifecycle_status: "DRAFT" | "APPROVED" | "ACTIVE" | "RETIRED";
  approval_id: string | null;
  origin_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrandSettings {
  restrictedPhrases: string[];
  affiliateDisclosure: string;
  aiDisclosureRequired: boolean;
  minBodyChars: number;
  evidenceMaxAgeDays: number;
}

export const DEFAULT_BRAND_SETTINGS: BrandSettings = {
  restrictedPhrases: [
    "cure",
    "cures",
    "treats sleep apnea",
    "guaranteed",
    "doctor recommended",
    "clinically proven",
    "faa approved",
    "tsa approved",
    "safe for everyone",
    "works with all",
    "compatible with all",
  ],
  affiliateDisclosure: "This article contains affiliate links. We may earn a commission if you buy through them, at no extra cost to you.",
  aiDisclosureRequired: true,
  minBodyChars: 600,
  evidenceMaxAgeDays: 365,
};

export function listBrands(): BrandRow[] {
  return getDb().prepare("SELECT * FROM brands ORDER BY created_at").all() as BrandRow[];
}

export function getBrand(id: string): BrandRow {
  const b = getDb().prepare("SELECT * FROM brands WHERE id = ?").get(id) as BrandRow | undefined;
  if (!b) throw new AppError("NOT_FOUND", `Brand ${id} not found`, 404);
  return b;
}

export function brandSettings(b: BrandRow): BrandSettings {
  return { ...DEFAULT_BRAND_SETTINGS, ...parseJson<Partial<BrandSettings>>(b.settings_json, {}) };
}

export function selectedBrandId(): string {
  const id = getSetting<string | null>("selected_brand", null);
  if (id && getDb().prepare("SELECT 1 FROM brands WHERE id = ?").get(id)) return id;
  const first = listBrands()[0];
  if (!first) throw new AppError("NO_BRAND", "No brand exists. Run npm run migrate to seed the initial brand.", 500);
  return first.id;
}

export function selectBrand(id: string, actor: string) {
  getBrand(id);
  setSetting("selected_brand", id);
  audit({ actor, action: "brand.select", subjectType: "brand", subjectId: id, brandId: id, summary: `Selected brand ${id}` });
}

export function updateBrand(
  id: string,
  patch: Partial<Pick<BrandRow, "name" | "market" | "language" | "currency" | "objective" | "description">> & { settings?: Partial<BrandSettings> },
  actor: string,
) {
  const b = getBrand(id);
  const settings = patch.settings ? JSON.stringify({ ...brandSettings(b), ...patch.settings }) : b.settings_json;
  if (patch.currency) assert(/^[A-Z]{3}$/.test(patch.currency), "BAD_CURRENCY", "Currency must be an ISO 4217 code like CAD.");
  getDb()
    .prepare(
      "UPDATE brands SET name=?, market=?, language=?, currency=?, objective=?, description=?, settings_json=?, updated_at=? WHERE id=?",
    )
    .run(
      patch.name?.trim() || b.name,
      patch.market?.trim() || b.market,
      patch.language?.trim() || b.language,
      patch.currency || b.currency,
      patch.objective ?? b.objective,
      patch.description ?? b.description,
      settings,
      nowIso(),
      id,
    );
  audit({ actor, action: "brand.update", subjectType: "brand", subjectId: id, brandId: id, summary: `Brand ${id} updated` });
}

export function activationBlockers(id: string): string[] {
  const reasons: string[] = [];
  const av = getDb().prepare("SELECT lifecycle_status FROM avatars WHERE brand_id = ? AND lifecycle_status IN ('APPROVED','ACTIVE')").get(id);
  if (!av) reasons.push("Approve an avatar configuration first.");
  return reasons;
}

export function setBrandStatus(id: string, status: BrandStatus, actor: string) {
  assert(BRAND_STATUSES.includes(status), "BAD_STATUS", `Unknown status ${status}`);
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator changes brand status.", 403);
  const b = getBrand(id);
  if (status === "ACTIVE") {
    const r = activationBlockers(id);
    if (r.length) throw new AppError("ACTIVATION_BLOCKED", r.join(" "), 409, r);
  }
  getDb().prepare("UPDATE brands SET status=?, updated_at=? WHERE id=?").run(status, nowIso(), id);
  audit({ actor, action: "brand.status", subjectType: "brand", subjectId: id, brandId: id, summary: `Brand ${b.name}: ${b.status} → ${status}` });
}

export function listPillars(brandId: string): PillarRow[] {
  return getDb().prepare("SELECT * FROM pillars WHERE brand_id = ? ORDER BY sort").all(brandId) as PillarRow[];
}

export function addPillar(brandId: string, name: string, actor: string) {
  assert(name.trim().length > 1, "BAD_INPUT", "Pillar name is required.");
  const n = listPillars(brandId).length;
  const id = newId("pillar");
  getDb().prepare("INSERT INTO pillars (id, brand_id, name, sort) VALUES (?,?,?,?)").run(id, brandId, name.trim(), n);
  audit({ actor, action: "pillar.add", subjectType: "pillar", subjectId: id, brandId, summary: `Pillar “${name.trim()}” added` });
  return id;
}

export function renamePillar(id: string, name: string, actor: string) {
  assert(name.trim().length > 1, "BAD_INPUT", "Pillar name is required.");
  const p = getDb().prepare("SELECT * FROM pillars WHERE id=?").get(id) as PillarRow | undefined;
  if (!p) throw new AppError("NOT_FOUND", "Pillar not found", 404);
  getDb().prepare("UPDATE pillars SET name=? WHERE id=?").run(name.trim(), id);
  audit({ actor, action: "pillar.rename", subjectType: "pillar", subjectId: id, brandId: p.brand_id, summary: `Pillar renamed to “${name.trim()}”` });
}

export function getAvatars(brandId: string): AvatarRow[] {
  return getDb().prepare("SELECT * FROM avatars WHERE brand_id = ? ORDER BY created_at").all(brandId) as AvatarRow[];
}

export function getAvatar(id: string): AvatarRow {
  const a = getDb().prepare("SELECT * FROM avatars WHERE id = ?").get(id) as AvatarRow | undefined;
  if (!a) throw new AppError("NOT_FOUND", "Avatar not found", 404);
  return a;
}

const AVATAR_FIELDS = ["name", "role", "bio", "personality", "voice_tone", "ai_disclosure", "expertise_boundary", "visual_ref", "voice_ref"] as const;

/** Editing an approved avatar returns it to DRAFT and invalidates its approval. */
export function updateAvatar(id: string, patch: Partial<Record<(typeof AVATAR_FIELDS)[number], string>> & { restricted_claims?: string[] }, actor: string) {
  const a = getAvatar(id);
  const next: Record<string, string> = {};
  for (const f of AVATAR_FIELDS) next[f] = (patch[f] ?? a[f]).toString();
  assert(next.name.trim().length > 0, "BAD_INPUT", "Avatar name is required.");
  assert(next.ai_disclosure.trim().length > 10, "BAD_INPUT", "An AI disclosure statement is required.");
  const rc = patch.restricted_claims ? JSON.stringify(patch.restricted_claims.map((s) => s.trim()).filter(Boolean)) : a.restricted_claims_json;
  const changed = AVATAR_FIELDS.some((f) => next[f] !== a[f]) || rc !== a.restricted_claims_json;
  if (!changed) return;
  tx(() => {
    getDb()
      .prepare(
        `UPDATE avatars SET name=?, role=?, bio=?, personality=?, voice_tone=?, ai_disclosure=?, expertise_boundary=?, visual_ref=?, voice_ref=?,
         restricted_claims_json=?, lifecycle_status=CASE WHEN lifecycle_status='RETIRED' THEN 'RETIRED' ELSE 'DRAFT' END, approval_id=NULL, updated_at=? WHERE id=?`,
      )
      .run(next.name, next.role, next.bio, next.personality, next.voice_tone, next.ai_disclosure, next.expertise_boundary, next.visual_ref, next.voice_ref, rc, nowIso(), id);
    if (a.approval_id) {
      getDb()
        .prepare("UPDATE approvals SET status='INVALIDATED', invalidated_at=?, invalidated_reason=? WHERE id=? AND status='ACTIVE'")
        .run(nowIso(), "Avatar configuration edited", a.approval_id);
    }
  });
  audit({ actor, action: "avatar.update", subjectType: "avatar", subjectId: id, brandId: a.brand_id, summary: `Avatar ${a.name} edited${a.approval_id ? " — approval invalidated" : ""}` });
}

export function approveAvatar(id: string, actor: string, note = "") {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator approves avatar configurations.", 403);
  const a = getAvatar(id);
  assert(a.lifecycle_status === "DRAFT", "BAD_STATE", `Avatar is ${a.lifecycle_status}.`);
  const apId = newId("approval");
  tx(() => {
    getDb()
      .prepare(
        `INSERT INTO approvals (id, subject_type, subject_id, decision, status, level, actor, note, created_at)
         VALUES (?, 'avatar', ?, 'APPROVED', 'ACTIVE', 4, ?, ?, ?)`,
      )
      .run(apId, id, actor, note, nowIso());
    getDb().prepare("UPDATE avatars SET lifecycle_status='APPROVED', approval_id=?, updated_at=? WHERE id=?").run(apId, nowIso(), id);
  });
  audit({ actor, action: "avatar.approve", subjectType: "avatar", subjectId: id, brandId: a.brand_id, summary: `Avatar ${a.name} configuration approved` });
  return apId;
}

export interface CloneInput {
  name: string;
  market: string;
  language: string;
  currency: string;
  newBrandId?: string;
}

/**
 * One-action clone: new stable IDs, remapped relationships, provenance kept.
 * Excludes credentials, approvals, publications, performance, costs and pending jobs.
 * Clone starts in DRAFT with its avatar in DRAFT and commercial facts marked for revalidation.
 */
export function cloneBrand(sourceId: string, input: CloneInput, actor: string): { brandId: string; idMap: Record<string, string> } {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator clones brands.", 403);
  assert(input.name.trim().length > 2, "BAD_INPUT", "Clone name is required.");
  assert(/^[A-Z]{3}$/.test(input.currency), "BAD_CURRENCY", "Currency must be an ISO 4217 code.");
  const src = getBrand(sourceId);
  const db = getDb();
  const idMap: Record<string, string> = {};
  const map = (old: string | null, prefix: string) => {
    if (!old) return null;
    if (!idMap[old]) idMap[old] = newId(prefix);
    return idMap[old];
  };
  const now = nowIso();
  const brandId = input.newBrandId || newId("brand");
  idMap[sourceId] = brandId;
  tx(() => {
    db.prepare(
      `INSERT INTO brands (id, name, status, market, language, currency, objective, description, settings_json, origin_id, provenance_json, created_at, updated_at)
       VALUES (?,?, 'DRAFT', ?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      brandId,
      input.name.trim(),
      input.market.trim(),
      input.language.trim(),
      input.currency,
      src.objective,
      src.description,
      src.settings_json,
      src.id,
      JSON.stringify({ clonedFrom: src.id, clonedAt: now, by: actor }),
      now,
      now,
    );
    for (const p of listPillars(sourceId)) {
      db.prepare("INSERT INTO pillars (id, brand_id, name, sort) VALUES (?,?,?,?)").run(map(p.id, "pillar"), brandId, p.name, p.sort);
    }
    for (const a of getAvatars(sourceId)) {
      db.prepare(
        `INSERT INTO avatars (id, brand_id, name, role, bio, personality, voice_tone, ai_disclosure, expertise_boundary, restricted_claims_json,
          visual_ref, voice_ref, lifecycle_status, origin_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?,?,?)`,
      ).run(map(a.id, "avatar"), brandId, a.name, a.role, a.bio, a.personality, a.voice_tone, a.ai_disclosure, a.expertise_boundary, a.restricted_claims_json, a.visual_ref, a.voice_ref, a.id, now, now);
    }
    // Workflow/content templates: IDEA-stage items only, as unresearched templates.
    const ideas = db.prepare("SELECT * FROM content_items WHERE brand_id = ? AND stage = 'IDEA' AND retired_at IS NULL").all(sourceId) as {
      id: string; title: string; content_type: string; pillar_id: string | null; risk: string; buyer_intent: string | null;
    }[];
    for (const c of ideas) {
      const cid = map(c.id, "content")!;
      const rid = newId("rev");
      db.prepare(
        `INSERT INTO content_items (id, brand_id, title, content_type, pillar_id, stage, buyer_intent, risk, current_revision_id, research_status, origin_id, created_at, updated_at)
         VALUES (?,?,?,?,?, 'IDEA', NULL, ?, ?, 'UNRESEARCHED', ?, ?, ?)`,
      ).run(cid, brandId, c.title, c.content_type, c.pillar_id ? idMap[c.pillar_id] ?? null : null, c.risk, rid, c.id, now, now);
      db.prepare(
        "INSERT INTO content_revisions (id, content_id, number, title, body, change_note, author, hash, created_at) VALUES (?,?,1,?, '', ?, ?, ?, ?)",
      ).run(rid, cid, c.title, `Cloned from ${c.id}`, actor, "", now);
    }
    // Monetization configuration: programs + facts, requiring revalidation. Offers are copied inactive.
    const programs = db.prepare("SELECT * FROM programs WHERE brand_id = ?").all(sourceId) as Record<string, unknown>[];
    for (const p of programs) {
      const pid = map(p.id as string, "program")!;
      db.prepare(
        `INSERT INTO programs (id, brand_id, name, network, url, program_status, account_status, notes, legacy, origin_id, created_at, updated_at)
         VALUES (?,?,?,?,?, 'DISCOVERED', 'NOT_APPLIED', ?, 0, ?, ?, ?)`,
      ).run(pid, brandId, p.name, p.network, p.url, p.notes, p.id, now, now);
      const facts = db.prepare("SELECT * FROM commercial_facts WHERE program_id = ?").all(p.id) as Record<string, unknown>[];
      for (const f of facts) {
        db.prepare(
          `INSERT INTO commercial_facts (id, program_id, criterion, value, source_url, checked_at, evidence, status, provenance_json, updated_at)
           VALUES (?,?,?,?,?,?,?, 'UNVERIFIED', ?, ?)`,
        ).run(
          newId("fact"),
          pid,
          f.criterion,
          f.value,
          f.source_url,
          f.checked_at,
          f.evidence,
          JSON.stringify({ copiedFrom: f.id, originalStatus: f.status, originalCheckedAt: f.checked_at, revalidation: "REQUIRED" }),
          now,
        );
      }
      const offers = db.prepare("SELECT * FROM offers WHERE program_id = ?").all(p.id) as Record<string, unknown>[];
      for (const o of offers) {
        db.prepare(
          `INSERT INTO offers (id, brand_id, program_id, name, product_url, affiliate_url, disclosure, offer_status, link_status, commission_text, checked_at, created_at, updated_at)
           VALUES (?,?,?,?,?, '', ?, 'DRAFT', 'INACTIVE', ?, NULL, ?, ?)`,
        ).run(map(o.id as string, "offer"), brandId, pid, o.name, o.product_url, o.disclosure, o.commission_text, now, now);
      }
    }
  });
  audit({ actor, action: "brand.clone", subjectType: "brand", subjectId: brandId, brandId, summary: `Cloned ${src.name} → ${input.name} (DRAFT)`, data: { idMapSize: Object.keys(idMap).length } });
  return { brandId, idMap };
}
