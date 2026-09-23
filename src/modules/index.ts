import { ProviderError } from "@/adapters/http";
import { getDb } from "@/core/db";
import { runQaNow } from "@/core/content";
import { markIntegrationDegraded, markIntegrationSuccess } from "@/core/integrations";
import { blockJob, blockReasons, completeJob, failJob, getJob, JOB_TYPES, setSideEffect, type JobRow } from "@/core/jobs";
import { isSystemPaused, pausedJobTypes } from "@/core/settings";
import { CAP } from "@/core/types";
import { AppError, redact } from "@/core/util";
import { JobContext, LeaseLost } from "./context";
import { runAnalyticsSync, runDriveImport, runMcpCall, runMcpDiscover, runRecommend } from "./data";
import { runFindOffers } from "./offers";
import { runPublish } from "./publish";
import { runResearch } from "./research";
import { runEditorialQa, runRevise, runScript } from "./writing";

type Handler = (ctx: JobContext) => Promise<unknown>;

export const HANDLERS: Record<string, Handler> = {
  RESEARCH: runResearch,
  SCRIPT: runScript,
  REVISE: runRevise,
  QA_DETERMINISTIC: async (ctx) => {
    const r = runQaNow(ctx.job.content_id!, "worker");
    return { reportId: r.reportId, result: r.result, note: "Structural checks only — not a factual or medical review." };
  },
  QA_EDITORIAL: runEditorialQa,
  FIND_OFFERS: runFindOffers,
  PUBLISH: runPublish,
  ANALYTICS_SYNC: runAnalyticsSync,
  DRIVE_IMPORT: runDriveImport,
  RECOMMEND: runRecommend,
  MCP_DISCOVER: runMcpDiscover,
  MCP_CALL: runMcpCall,
};

const PROVIDER_CAP: Record<string, string> = {
  anthropic: CAP.AI,
  brave: CAP.RESEARCH,
  wordpress: CAP.PUBLISH,
  ga4: CAP.ANALYTICS,
  google_drive: CAP.DRIVE,
};

/** Content-bound jobs must still target existing, non-retired content. */
function contentPrecheck(job: JobRow): string[] {
  if (!job.content_id) return [];
  const c = getDb().prepare("SELECT retired_at FROM content_items WHERE id = ?").get(job.content_id) as { retired_at: string | null } | undefined;
  if (!c) return ["Content no longer exists."];
  if (c.retired_at) return ["Content is retired."];
  return [];
}

/**
 * Executes one claimed job. Re-checks permissions, provider readiness, brand status, budget and
 * approvals immediately before running, then maps any failure to a safe job state.
 */
export async function executeJob(job: JobRow, workerId: string): Promise<string> {
  const handler = HANDLERS[job.type];
  if (!handler) {
    failJob(job.id, workerId, { code: "NO_HANDLER", message: `No handler for ${job.type}`, retryable: false });
    return "FAILED";
  }
  if (isSystemPaused() || pausedJobTypes().includes(job.type)) {
    blockJob(job.id, workerId, ["Automation paused by the operator."]);
    return "BLOCKED";
  }
  const reasons = [...blockReasons(job), ...contentPrecheck(job)];
  if (reasons.length) {
    if (reasons.some((r) => r.startsWith("Content"))) {
      failJob(job.id, workerId, { code: "PRECHECK", message: reasons.join(" "), retryable: false });
      return "FAILED";
    }
    blockJob(job.id, workerId, reasons);
    return "BLOCKED";
  }
  const ctx = new JobContext(getJob(job.id), workerId);
  const beat = setInterval(() => {
    try {
      ctx.progress(getJob(job.id).progress_text || "Running");
    } catch {
      /* lease lost is detected on completion */
    }
  }, 15_000);
  try {
    const out = await handler(ctx);
    for (const cap of JOB_TYPES[job.type].caps) markIntegrationSuccess(cap);
    const ok = completeJob(job.id, workerId, out);
    return ok ? "COMPLETE" : "DISCARDED";
  } catch (e) {
    if (e instanceof LeaseLost) return "LEASE_LOST";
    if (e instanceof ProviderError) {
      const cap = PROVIDER_CAP[e.provider];
      if (e.auth && cap) markIntegrationDegraded(cap, { code: e.code, message: e.message });
      // A definitive refusal (e.g. HTTP 4xx) means the side effect did not happen: safe to treat as not sent.
      const cur = getJob(job.id);
      if (!e.maybeDelivered && cur.side_effect_state === "REQUESTED") setSideEffect(job.id, workerId, "NONE");
      return failJob(job.id, workerId, {
        code: e.code,
        message: e.message,
        retryable: e.retryable,
        blocking: e.auth,
        details: { provider: e.provider, status: e.status },
      });
    }
    if (e instanceof AppError) {
      // Business-rule failures (stale approval, changed revision, missing evidence) are permanent for this job.
      return failJob(job.id, workerId, { code: e.code, message: e.message, retryable: false });
    }
    return failJob(job.id, workerId, { code: "INTERNAL", message: redact((e as Error).message ?? String(e)), retryable: true });
  } finally {
    clearInterval(beat);
  }
}
