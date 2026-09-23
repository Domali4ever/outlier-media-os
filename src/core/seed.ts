import { getDb, tx } from "./db";
import { audit } from "./audit";
import { ensureIntegrations } from "./integrations";
import { nowIso } from "./util";

export const INITIAL_BRAND_ID = "brand_cpap_travel";

const PILLARS: [string, string][] = [
  ["pillar_cpap_ownership", "Ownership & Maintenance"],
  ["pillar_cpap_travel", "Travel"],
  ["pillar_cpap_accessories", "Accessories"],
  ["pillar_cpap_power", "Power & Adapters"],
  ["pillar_cpap_cleaning", "Cleaning & Organization"],
];

/** Unresearched topic suggestions. They are NOT validated opportunities. */
const IDEAS: { id: string; title: string; pillar: string; risk: "LOW" | "MEDIUM" | "HIGH" }[] = [
  { id: "content_idea_001", title: "Packing a CPAP for a carry-on-only trip", pillar: "pillar_cpap_travel", risk: "MEDIUM" },
  { id: "content_idea_002", title: "What to look for in a CPAP travel case", pillar: "pillar_cpap_accessories", risk: "LOW" },
  { id: "content_idea_003", title: "Keeping a filter replacement schedule", pillar: "pillar_cpap_ownership", risk: "MEDIUM" },
  { id: "content_idea_004", title: "Tube management at home and on the road", pillar: "pillar_cpap_accessories", risk: "LOW" },
  { id: "content_idea_005", title: "Organizing masks, cushions and headgear", pillar: "pillar_cpap_cleaning", risk: "LOW" },
  { id: "content_idea_006", title: "Running a CPAP away from an outlet", pillar: "pillar_cpap_power", risk: "HIGH" },
  { id: "content_idea_007", title: "Plug adapters vs voltage converters abroad", pillar: "pillar_cpap_power", risk: "HIGH" },
  { id: "content_idea_008", title: "Documents to carry when flying with a CPAP", pillar: "pillar_cpap_travel", risk: "HIGH" },
];

/** Initializes honest empty operational state. Idempotent: does nothing if a brand exists. */
export function seedIfEmpty(): boolean {
  ensureIntegrations();
  const db = getDb();
  const n = (db.prepare("SELECT COUNT(*) n FROM brands").get() as { n: number }).n;
  if (n > 0) return false;
  const now = nowIso();
  tx(() => {
    db.prepare(
      `INSERT INTO brands (id, name, status, market, language, currency, objective, description, settings_json, provenance_json, created_at, updated_at)
       VALUES (?,?, 'DRAFT', ?,?,?,?,?, '{}', ?, ?, ?)`,
    ).run(
      INITIAL_BRAND_ID,
      "CPAP Ownership + Travel",
      "CA",
      "en",
      "CAD",
      "Operate an evidence-based affiliate content workflow with minimal required human attention.",
      "Practical content about CPAP ownership, accessories, organization and travel: carrying cases, filters, tube management, mask organization, cleaning accessories, adapters, compatible power options, batteries and luggage packing. No individualized medical advice or treatment claims.",
      JSON.stringify({ seededAt: now, source: "initial configuration" }),
      now,
      now,
    );
    PILLARS.forEach(([id, name], i) => db.prepare("INSERT INTO pillars (id, brand_id, name, sort) VALUES (?,?,?,?)").run(id, INITIAL_BRAND_ID, name, i));
    db.prepare(
      `INSERT INTO avatars (id, brand_id, name, role, bio, personality, voice_tone, ai_disclosure, expertise_boundary, restricted_claims_json, visual_ref, voice_ref, lifecycle_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, '', '', 'DRAFT', ?, ?)`,
    ).run(
      "avatar_cpap_guide_001",
      INITIAL_BRAND_ID,
      "CPAP Travel Guide (AI)",
      "AI presenter for ownership and travel logistics",
      "An AI-generated guide to packing, organizing and maintaining CPAP gear. Not a clinician, and has no personal use history.",
      "Calm, practical, checklist-minded",
      "Plain language, second person, no hype",
      "This article was produced with AI assistance and reviewed against cited sources. It is not medical advice.",
      "Logistics, organization and accessories. Defers to clinicians and device manufacturers on therapy, pressure and device settings.",
      JSON.stringify([
        "Medical outcomes or treatment effects",
        "Pressure or therapy settings",
        "Personal product use or experience",
        "Device compatibility without a dated manufacturer source",
        "Airline or airport rules without a dated official source",
      ]),
      now,
      now,
    );
    for (const i of IDEAS) {
      const rid = `rev_${i.id}_1`;
      db.prepare(
        `INSERT INTO content_items (id, brand_id, title, content_type, pillar_id, stage, buyer_intent, risk, current_revision_id, research_status, created_at, updated_at)
         VALUES (?,?,?, 'article', ?, 'IDEA', NULL, ?, ?, 'UNRESEARCHED', ?, ?)`,
      ).run(i.id, INITIAL_BRAND_ID, i.title, i.pillar, i.risk, rid, now, now);
      db.prepare(
        "INSERT INTO content_revisions (id, content_id, number, title, body, change_note, author, hash, created_at) VALUES (?,?,1,?, '', 'Unresearched topic suggestion', 'system', '', ?)",
      ).run(rid, i.id, i.title, now);
    }
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('selected_brand', ?, ?)").run(JSON.stringify(INITIAL_BRAND_ID), now);
  });
  audit({ actor: "system", action: "seed", subjectType: "brand", subjectId: INITIAL_BRAND_ID, brandId: INITIAL_BRAND_ID, summary: `Initialized ${INITIAL_BRAND_ID} (DRAFT), 1 draft avatar, 5 pillars and ${IDEAS.length} UNRESEARCHED topic ideas. No operational history was invented.` });
  return true;
}
