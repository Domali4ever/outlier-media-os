import { getDb } from "./db";
import { isCapabilityReady } from "./integrations";
import { CAP } from "./types";

export interface Milestone {
  n: string;
  title: string;
  done: boolean;
  state: "DONE" | "NOT_STARTED" | "IN_PROGRESS" | "BLOCKED" | "UNVERIFIED" | "NO_DATA";
  note: string;
}

/** Milestones derived only from real saved records — never from fixtures or simulated activity. */
export function brandMilestones(brandId: string): Milestone[] {
  const db = getDb();
  const one = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
  const sourced = one(
    `SELECT COUNT(DISTINCT c.id) n FROM content_items c JOIN evidence e ON e.content_id = c.id
     WHERE c.brand_id = ? AND e.url IS NOT NULL AND e.checked_at IS NOT NULL AND e.kind != 'PUBLICATION_PROOF' AND length((SELECT body FROM content_revisions r WHERE r.id = c.current_revision_id)) > 200`,
    brandId,
  );
  const qualified = one("SELECT COUNT(*) n FROM programs WHERE brand_id = ? AND program_status = 'QUALIFIED'", brandId);
  const legacyPrograms = one("SELECT COUNT(*) n FROM programs WHERE brand_id = ? AND legacy = 1", brandId);
  const discovered = one("SELECT COUNT(*) n FROM programs WHERE brand_id = ?", brandId);
  const qaCycle = one(
    `SELECT COUNT(DISTINCT q.content_id) n FROM qa_reports q JOIN content_items c ON c.id = q.content_id
     WHERE c.brand_id = ? AND q.kind = 'DETERMINISTIC' AND q.result != 'FAIL'
       AND EXISTS (SELECT 1 FROM qa_reports q2 WHERE q2.content_id = q.content_id AND q2.revision_id = q.revision_id AND q2.kind IN ('AI_EDITORIAL','HUMAN_REVIEW') AND q2.result != 'FAIL')`,
    brandId,
  );
  const approved = one(
    `SELECT COUNT(*) n FROM approvals a JOIN content_items c ON c.id = a.subject_id
     WHERE a.subject_type = 'content' AND c.brand_id = ? AND a.status = 'ACTIVE' AND a.decision = 'APPROVED' AND a.revision_id = c.current_revision_id`,
    brandId,
  );
  const ready = one("SELECT COUNT(*) n FROM content_items WHERE brand_id = ? AND stage = 'READY' AND retired_at IS NULL", brandId);
  const published = one("SELECT COUNT(*) n FROM publications p JOIN content_items c ON c.id = p.content_id WHERE c.brand_id = ? AND p.status IN ('CONFIRMED','MANUAL_CONFIRMED')", brandId);
  const obs = one("SELECT COUNT(*) n FROM performance_observations WHERE brand_id = ? AND content_id IS NOT NULL", brandId);
  const recs = one("SELECT COUNT(*) n FROM recommendations WHERE brand_id = ? AND data_sufficiency != 'INSUFFICIENT' AND legacy = 0", brandId);
  const investigate = one("SELECT COUNT(*) n FROM recommendations WHERE brand_id = ? AND type = 'INVESTIGATE'", brandId);
  const m = (n: string, title: string, done: boolean, notDone: Milestone["state"], note: string, doneNote: string): Milestone => ({
    n,
    title,
    done,
    state: done ? "DONE" : notDone,
    note: done ? doneNote : note,
  });
  return [
    m("01", "Content package with documented sources", sourced > 0, "NOT_STARTED", "No item has a script backed by dated sources yet", `${sourced} item(s)`),
    m("02", "Qualified commercial opportunity", qualified > 0, legacyPrograms ? "UNVERIFIED" : discovered ? "IN_PROGRESS" : "NOT_STARTED", legacyPrograms ? "Legacy claim imported without evidence" : discovered ? `${discovered} discovered, none qualified` : "No programs recorded", `${qualified} qualified`),
    m("03", "Completed QA cycle", qaCycle > 0, "NOT_STARTED", "No revision has passed deterministic + editorial review", `${qaCycle} item(s)`),
    m("04", "Human approval tied to the current revision", approved > 0, "NOT_STARTED", "No active approval on a current revision", `${approved} active approval(s)`),
    m("05", "Publish-ready asset", ready > 0 || published > 0, "BLOCKED", "Needs 03, 04 and commercial clearance", `${ready} ready`),
    m("06", "Confirmed publication", published > 0, isCapabilityReady(CAP.PUBLISH) ? "NOT_STARTED" : "BLOCKED", isCapabilityReady(CAP.PUBLISH) ? "Nothing published yet" : "No publishing destination connected (manual publication with evidence also counts)", `${published} publication(s)`),
    m("07", "Real performance ingestion with defined coverage", obs > 0, isCapabilityReady(CAP.ANALYTICS) ? "NO_DATA" : "BLOCKED", isCapabilityReady(CAP.ANALYTICS) ? "Connected; no observations yet" : "No analytics source connected (CSV import available)", `${obs} observation(s)`),
    m("08", "Evidence-based recommendation", recs > 0, "NO_DATA", investigate ? "Only INVESTIGATE so far — data insufficient" : "Defaults to INVESTIGATE until data exists", `${recs} recommendation(s)`),
  ];
}
