import { getDb } from "./db";
import { activeContentApproval, getContent } from "./content";
import { isCapabilityReady } from "./integrations";
import { createJob } from "./jobs";
import { activePolicy, type RecurringPublicationConfig } from "./policies";
import { CAP } from "./types";
import { parseJson } from "./util";

/**
 * Scheduled, policy-bound automation run by the worker:
 * - daily analytics sync when analytics is CONNECTED;
 * - recurring publication ONLY under an ACTIVE recurring_publication policy, only after the brand's
 *   first (explicitly operator-requested) publication, only for READY items that each carry their own
 *   revision-bound approval, and within the policy's weekly cap.
 */
export function scheduleRecurring(): string[] {
  const db = getDb();
  const created: string[] = [];
  const brands = db.prepare("SELECT id FROM brands WHERE status = 'ACTIVE'").all() as { id: string }[];
  const day = new Date().toISOString().slice(0, 10);
  for (const b of brands) {
    if (isCapabilityReady(CAP.ANALYTICS)) {
      const hasPubs = db.prepare("SELECT 1 FROM publications p JOIN content_items c ON c.id=p.content_id WHERE c.brand_id=? LIMIT 1").get(b.id);
      if (hasPubs) {
        const { job, created: c } = createJob({ type: "ANALYTICS_SYNC", brandId: b.id, actor: "scheduler", idempotencyKey: `ANALYTICS_SYNC:${b.id}:${day}` });
        if (c) created.push(job.id);
      }
    }
    const policy = activePolicy("recurring_publication", b.id);
    if (!policy || !isCapabilityReady(CAP.PUBLISH)) continue;
    const cfg = parseJson<RecurringPublicationConfig>(policy.config_json, { destination: CAP.PUBLISH, maxPerWeek: 0 });
    const first = db.prepare("SELECT 1 FROM publications p JOIN content_items c ON c.id=p.content_id WHERE c.brand_id=? AND p.status IN ('CONFIRMED','MANUAL_CONFIRMED') LIMIT 1").get(b.id);
    if (!first) continue;
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const recent = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='PUBLISH' AND brand_id=? AND created_at > ? AND actor LIKE 'policy:%'").get(b.id, weekAgo) as { n: number }).n;
    let budget = cfg.maxPerWeek - recent;
    const ready = db.prepare("SELECT id FROM content_items WHERE brand_id=? AND stage='READY' AND retired_at IS NULL AND destination=? ORDER BY updated_at").all(b.id, cfg.destination) as { id: string }[];
    for (const r of ready) {
      if (budget <= 0) break;
      const item = getContent(r.id);
      const ap = activeContentApproval(item);
      if (!ap) continue;
      const { job, created: c } = createJob({
        type: "PUBLISH",
        brandId: b.id,
        contentId: item.id,
        revisionId: item.current_revision_id,
        approvalId: ap.id,
        actor: `policy:${policy.id}`,
        input: { destination: item.destination, policyVersion: policy.version },
        idempotencyKey: `PUBLISH:${item.id}:${item.current_revision_id}:${ap.id}`,
      });
      if (c) {
        created.push(job.id);
        budget--;
      }
    }
  }
  return created;
}
