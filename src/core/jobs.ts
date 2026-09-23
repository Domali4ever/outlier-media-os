import { getDb, tx } from "./db";
import { audit } from "./audit";
import { capabilityBlockReason } from "./integrations";
import { budgetBlockReason } from "./policies";
import { getSecret, isSystemPaused, pausedJobTypes } from "./settings";
import { activePolicy } from "./policies";
import { CAP, type Capability, type JobState, type PermissionLevel } from "./types";
import { AppError, addSeconds, newId, nowIso, parseJson, redact, sha256, stableStringify } from "./util";

export interface JobTypeDef {
  type: string;
  label: string;
  level: PermissionLevel;
  caps: Capability[];
  paid: boolean;
  /** Has an external side effect that must never be blindly retried. */
  sideEffect: boolean;
  /** Requires the brand to be ACTIVE. Local deterministic work does not. */
  needsActiveBrand: boolean;
  maxAttempts: number;
}

export const JOB_TYPES: Record<string, JobTypeDef> = {
  RESEARCH: { type: "RESEARCH", label: "Generate research", level: 1, caps: [CAP.AI, CAP.RESEARCH], paid: true, sideEffect: false, needsActiveBrand: true, maxAttempts: 3 },
  SCRIPT: { type: "SCRIPT", label: "Generate script", level: 1, caps: [CAP.AI], paid: true, sideEffect: false, needsActiveBrand: true, maxAttempts: 3 },
  REVISE: { type: "REVISE", label: "Fix with AI", level: 1, caps: [CAP.AI], paid: true, sideEffect: false, needsActiveBrand: true, maxAttempts: 3 },
  QA_DETERMINISTIC: { type: "QA_DETERMINISTIC", label: "Deterministic QA", level: 2, caps: [], paid: false, sideEffect: false, needsActiveBrand: false, maxAttempts: 2 },
  QA_EDITORIAL: { type: "QA_EDITORIAL", label: "AI editorial review", level: 1, caps: [CAP.AI], paid: true, sideEffect: false, needsActiveBrand: true, maxAttempts: 3 },
  FIND_OFFERS: { type: "FIND_OFFERS", label: "Find offers", level: 1, caps: [CAP.AI, CAP.RESEARCH], paid: true, sideEffect: false, needsActiveBrand: true, maxAttempts: 3 },
  PUBLISH: { type: "PUBLISH", label: "Publish", level: 3, caps: [CAP.PUBLISH], paid: false, sideEffect: true, needsActiveBrand: true, maxAttempts: 3 },
  ANALYTICS_SYNC: { type: "ANALYTICS_SYNC", label: "Sync analytics", level: 1, caps: [CAP.ANALYTICS], paid: false, sideEffect: false, needsActiveBrand: false, maxAttempts: 3 },
  DRIVE_IMPORT: { type: "DRIVE_IMPORT", label: "Import from Google Drive", level: 1, caps: [CAP.DRIVE], paid: false, sideEffect: false, needsActiveBrand: false, maxAttempts: 3 },
  RECOMMEND: { type: "RECOMMEND", label: "Refresh recommendations", level: 1, caps: [], paid: false, sideEffect: false, needsActiveBrand: false, maxAttempts: 2 },
  MCP_DISCOVER: { type: "MCP_DISCOVER", label: "Discover MCP tools", level: 1, caps: [], paid: false, sideEffect: false, needsActiveBrand: false, maxAttempts: 2 },
  MCP_CALL: { type: "MCP_CALL", label: "Call MCP tool", level: 2, caps: [], paid: false, sideEffect: true, needsActiveBrand: false, maxAttempts: 1 },
};

export interface JobRow {
  id: string;
  type: string;
  brand_id: string | null;
  content_id: string | null;
  revision_id: string | null;
  input_json: string;
  output_json: string | null;
  state: JobState;
  actor: string;
  permission_level: number;
  depends_on_json: string;
  blocked_reason_json: string | null;
  idempotency_key: string;
  approval_id: string | null;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  side_effect_state: "NONE" | "REQUESTED" | "CONFIRMED" | "AMBIGUOUS";
  usage_json: string | null;
  cost_estimate: number | null;
  error_json: string | null;
  progress_text: string;
  correlation_id: string;
  legacy: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const TERMINAL: JobState[] = ["COMPLETE", "FAILED", "CANCELLED"];
export const LEASE_SECONDS = 60;

export function jobEvent(jobId: string, state: string, message: string, data?: unknown) {
  getDb()
    .prepare("INSERT INTO job_events (job_id, at, state, message, data_json) VALUES (?,?,?,?,?)")
    .run(jobId, nowIso(), state, redact(message), data === undefined ? null : redact(JSON.stringify(data)));
}

export function getJob(id: string): JobRow {
  const j = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  if (!j) throw new AppError("NOT_FOUND", `Job ${id} not found`, 404);
  return j;
}

export function listJobs(opts: { states?: JobState[]; limit?: number; brandId?: string; contentId?: string } = {}): JobRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.states?.length) {
    where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
    args.push(...opts.states);
  }
  if (opts.brandId) {
    where.push("(brand_id = ? OR brand_id IS NULL)");
    args.push(opts.brandId);
  }
  if (opts.contentId) {
    where.push("content_id = ?");
    args.push(opts.contentId);
  }
  return getDb()
    .prepare(`SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, opts.limit ?? 200) as JobRow[];
}

export function jobCounts(): Record<JobState, number> {
  const rows = getDb().prepare("SELECT state, COUNT(*) n FROM jobs GROUP BY state").all() as { state: JobState; n: number }[];
  const out = { QUEUED: 0, BLOCKED: 0, RUNNING: 0, RETRYING: 0, COMPLETE: 0, FAILED: 0, NEEDS_ATTENTION: 0, CANCELLED: 0 } as Record<JobState, number>;
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export function jobEvents(jobId: string) {
  return getDb().prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id").all(jobId) as {
    id: number;
    at: string;
    state: string;
    message: string;
    data_json: string | null;
  }[];
}

/** Unknown pricing is never permission for unlimited spend: prices must be configured so the cap can be enforced. */
export function pricingBlockReason(brandId: string | null): string | null {
  const pin = Number(getSecret("ANTHROPIC_PRICE_INPUT_PER_MTOK") ?? "");
  const pout = Number(getSecret("ANTHROPIC_PRICE_OUTPUT_PER_MTOK") ?? "");
  if (!(pin > 0) || !(pout > 0))
    return "AI token prices are not configured (ANTHROPIC_PRICE_INPUT_PER_MTOK / ANTHROPIC_PRICE_OUTPUT_PER_MTOK), so spend cannot be checked against the cap.";
  const cap = brandId ? activePolicy("budget", brandId) : undefined;
  const priceCur = getSecret("ANTHROPIC_PRICE_CURRENCY") || "USD";
  if (cap) {
    const c = JSON.parse(cap.config_json) as { currency: string };
    if (c.currency !== priceCur) return `Spend cap is in ${c.currency} but AI prices are in ${priceCur}; set them in the same currency.`;
  }
  return null;
}

/** Every reason this job cannot run right now. Empty array = eligible. */
export function blockReasons(job: Pick<JobRow, "type" | "brand_id" | "approval_id">): string[] {
  const def = JOB_TYPES[job.type];
  if (!def) return [`Unknown job type ${job.type}`];
  const reasons: string[] = [];
  for (const c of def.caps) {
    const r = capabilityBlockReason(c);
    if (r) reasons.push(r);
  }
  if (def.needsActiveBrand && job.brand_id) {
    const b = getDb().prepare("SELECT status FROM brands WHERE id = ?").get(job.brand_id) as { status: string } | undefined;
    if (!b) reasons.push("Brand not found.");
    else if (b.status !== "ACTIVE") reasons.push(`Brand is ${b.status} — activate it in BRAND.`);
  }
  if (def.paid) {
    const r = budgetBlockReason(job.brand_id);
    if (r) reasons.push(r);
    const pr = pricingBlockReason(job.brand_id);
    if (pr) reasons.push(pr);
  }
  if (def.level >= 3 && !job.approval_id) reasons.push("Needs an explicit approval record.");
  return reasons;
}

export interface CreateJobInput {
  type: string;
  brandId?: string | null;
  contentId?: string | null;
  revisionId?: string | null;
  input?: Record<string, unknown>;
  actor: string;
  approvalId?: string | null;
  idempotencyKey?: string;
  dependsOn?: string[];
  /** When the previous job with the same key is terminal, start a fresh run (operator RUN). */
  rerun?: boolean;
}

/**
 * Creates a durable job. Duplicate protection: an identical active job (same idempotency key)
 * is returned instead of creating a second one.
 */
export function createJob(i: CreateJobInput): { job: JobRow; created: boolean } {
  const def = JOB_TYPES[i.type];
  if (!def) throw new AppError("BAD_JOB_TYPE", `Unknown job type ${i.type}`);
  if (i.actor !== "operator" && def.level >= 3 && !i.approvalId)
    throw new AppError("PERMISSION", `${def.label} is level ${def.level}; automated actors need an approval or policy.`, 403);
  const base =
    i.idempotencyKey ??
    `${i.type}:${i.brandId ?? "-"}:${i.contentId ?? "-"}:${i.revisionId ?? "-"}:${sha256(stableStringify(i.input ?? {})).slice(0, 16)}`;
  return tx(() => {
    const db = getDb();
    const prior = db
      .prepare("SELECT * FROM jobs WHERE idempotency_key = ? OR idempotency_key LIKE ? ORDER BY created_at DESC LIMIT 1")
      .get(base, `${base}#%`) as JobRow | undefined;
    let key = base;
    if (prior) {
      if (!TERMINAL.includes(prior.state)) return { job: prior, created: false };
      if (!i.rerun) return { job: prior, created: false };
      const n = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE idempotency_key = ? OR idempotency_key LIKE ?").get(base, `${base}#%`) as { n: number }).n;
      key = `${base}#${n + 1}`;
    }
    const id = newId("job");
    const now = nowIso();
    const reasons = blockReasons({ type: i.type, brand_id: i.brandId ?? null, approval_id: i.approvalId ?? null });
    const state: JobState = reasons.length ? "BLOCKED" : "QUEUED";
    db.prepare(
      `INSERT INTO jobs (id, type, brand_id, content_id, revision_id, input_json, state, actor, permission_level, depends_on_json,
         blocked_reason_json, idempotency_key, approval_id, max_attempts, run_after, correlation_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      i.type,
      i.brandId ?? null,
      i.contentId ?? null,
      i.revisionId ?? null,
      JSON.stringify(i.input ?? {}),
      state,
      i.actor,
      def.level,
      JSON.stringify(i.dependsOn ?? []),
      reasons.length ? JSON.stringify(reasons) : null,
      key,
      i.approvalId ?? null,
      def.maxAttempts,
      now,
      newId("corr"),
      now,
      now,
    );
    jobEvent(id, state, state === "BLOCKED" ? `Blocked: ${reasons.join(" ")}` : "Queued", reasons.length ? { reasons } : undefined);
    audit({
      actor: i.actor,
      action: "job.create",
      subjectType: "job",
      subjectId: id,
      brandId: i.brandId ?? null,
      summary: `${def.label} job ${id} ${state === "BLOCKED" ? "BLOCKED — " + reasons.join(" ") : "queued"}`,
      level: state === "BLOCKED" ? "WARN" : "INFO",
    });
    return { job: getJob(id), created: true };
  });
}

/** Moves BLOCKED jobs whose dependencies are now satisfied back to QUEUED; refreshes reasons for the rest. */
export function reevaluateBlocked(): number {
  const db = getDb();
  const blocked = db.prepare("SELECT * FROM jobs WHERE state = 'BLOCKED'").all() as JobRow[];
  let released = 0;
  for (const j of blocked) {
    const deps = parseJson<string[]>(j.depends_on_json, []);
    const reasons = blockReasons(j);
    for (const d of deps) {
      const dj = db.prepare("SELECT state FROM jobs WHERE id = ?").get(d) as { state: string } | undefined;
      if (!dj || dj.state !== "COMPLETE") reasons.push(`Waiting on job ${d}.`);
    }
    if (reasons.length === 0) {
      db.prepare("UPDATE jobs SET state='QUEUED', blocked_reason_json=NULL, updated_at=? WHERE id=? AND state='BLOCKED'").run(nowIso(), j.id);
      jobEvent(j.id, "QUEUED", "Dependencies satisfied — queued");
      released++;
    } else if (JSON.stringify(reasons) !== j.blocked_reason_json) {
      db.prepare("UPDATE jobs SET blocked_reason_json=?, updated_at=? WHERE id=?").run(JSON.stringify(reasons), nowIso(), j.id);
    }
  }
  return released;
}

/** Transactionally claims the next runnable job for a worker. */
export function claimNext(workerId: string): JobRow | null {
  if (isSystemPaused()) return null;
  const paused = pausedJobTypes();
  const db = getDb();
  return tx(() => {
    const now = nowIso();
    const cands = db
      .prepare(
        `SELECT j.* FROM jobs j LEFT JOIN brands b ON b.id = j.brand_id
         WHERE j.state IN ('QUEUED','RETRYING') AND j.run_after <= ?
           AND (b.status IS NULL OR b.status NOT IN ('PAUSED','ARCHIVED'))
         ORDER BY j.created_at LIMIT 20`,
      )
      .all(now) as JobRow[];
    const c = cands.find((j) => !paused.includes(j.type));
    if (!c) return null;
    const res = db
      .prepare(
        `UPDATE jobs SET state='RUNNING', lease_owner=?, lease_expires_at=?, heartbeat_at=?, attempts=attempts+1,
           started_at=COALESCE(started_at, ?), updated_at=? WHERE id=? AND state IN ('QUEUED','RETRYING')`,
      )
      .run(workerId, addSeconds(now, LEASE_SECONDS), now, now, now, c.id);
    if (res.changes !== 1) return null;
    jobEvent(c.id, "RUNNING", `Claimed by ${workerId} (attempt ${c.attempts + 1})`);
    return getJob(c.id);
  });
}

export function heartbeat(jobId: string, workerId: string, progress?: string): boolean {
  const now = nowIso();
  const r = getDb()
    .prepare(
      `UPDATE jobs SET heartbeat_at=?, lease_expires_at=?, progress_text=COALESCE(?, progress_text), updated_at=?
       WHERE id=? AND lease_owner=? AND state='RUNNING'`,
    )
    .run(now, addSeconds(now, LEASE_SECONDS), progress ?? null, now, jobId, workerId);
  return r.changes === 1;
}

export function setSideEffect(jobId: string, workerId: string, s: JobRow["side_effect_state"]) {
  getDb().prepare("UPDATE jobs SET side_effect_state=?, updated_at=? WHERE id=? AND lease_owner=?").run(s, nowIso(), jobId, workerId);
  jobEvent(jobId, "RUNNING", `Side effect ${s}`);
}

function finish(jobId: string, workerId: string, state: JobState, fields: Record<string, unknown>, message: string) {
  const sets = ["state=?", "updated_at=?", "lease_owner=NULL", "lease_expires_at=NULL"];
  const args: unknown[] = [state, nowIso()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=?`);
    args.push(v);
  }
  if (TERMINAL.includes(state) || state === "NEEDS_ATTENTION") {
    sets.push("finished_at=?");
    args.push(nowIso());
  }
  const r = getDb()
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id=? AND lease_owner=? AND state='RUNNING'`)
    .run(...args, jobId, workerId);
  if (r.changes === 1) jobEvent(jobId, state, message);
  return r.changes === 1;
}

export function completeJob(jobId: string, workerId: string, output: unknown) {
  const ok = finish(jobId, workerId, "COMPLETE", { output_json: redact(JSON.stringify(output ?? {})), error_json: null, progress_text: "Complete" }, "Complete");
  if (ok) {
    const j = getJob(jobId);
    audit({ actor: "worker", action: "job.complete", subjectType: "job", subjectId: jobId, brandId: j.brand_id, summary: `${JOB_TYPES[j.type]?.label ?? j.type} job ${jobId} complete`, correlationId: j.correlation_id });
  }
  return ok;
}

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
  /** Blocked by a dependency (e.g. auth failure) rather than a transient fault. */
  blocking?: boolean;
  details?: unknown;
}

export function failJob(jobId: string, workerId: string, f: JobFailure) {
  const j = getJob(jobId);
  const err = redact(JSON.stringify({ code: f.code, message: f.message, details: f.details, at: nowIso() }));
  const def = JOB_TYPES[j.type];
  let state: JobState;
  let msg: string;
  const extra: Record<string, unknown> = { error_json: err };
  if (def?.sideEffect && j.side_effect_state === "REQUESTED") {
    if (j.type === "PUBLISH" && j.attempts < j.max_attempts) {
      state = "RETRYING";
      extra.run_after = addSeconds(nowIso(), 60);
      extra.side_effect_state = "AMBIGUOUS";
      msg = `Ambiguous side effect (${f.message}). Will reconcile remote state before any retry.`;
    } else {
      state = "NEEDS_ATTENTION";
      extra.side_effect_state = "AMBIGUOUS";
      msg = `Ambiguous side effect (${f.message}). Operator review required.`;
    }
  } else if (f.blocking) {
    state = "BLOCKED";
    extra.blocked_reason_json = JSON.stringify([f.message]);
    msg = `Blocked: ${f.message}`;
  } else if (f.retryable && j.attempts < j.max_attempts) {
    state = "RETRYING";
    extra.run_after = addSeconds(nowIso(), 30 * 2 ** Math.max(0, j.attempts - 1));
    msg = `Attempt ${j.attempts} failed (${f.message}); retry scheduled`;
  } else {
    state = "FAILED";
    msg = `Failed: ${f.message}`;
  }
  const ok = finish(jobId, workerId, state, extra, msg);
  if (ok)
    audit({
      actor: "worker",
      action: `job.${state.toLowerCase()}`,
      subjectType: "job",
      subjectId: jobId,
      brandId: j.brand_id,
      summary: `${def?.label ?? j.type} job ${jobId}: ${msg}`,
      level: state === "FAILED" || state === "NEEDS_ATTENTION" ? "ERROR" : "WARN",
      correlationId: j.correlation_id,
    });
  return state;
}

export function blockJob(jobId: string, workerId: string, reasons: string[]) {
  return finish(jobId, workerId, "BLOCKED", { blocked_reason_json: JSON.stringify(reasons), attempts: getJob(jobId).attempts - 1 }, `Blocked at pre-execution check: ${reasons.join(" ")}`);
}

/** Restart recovery: RUNNING jobs whose lease expired (worker died) are retried or escalated. */
export function recoverExpiredLeases(): number {
  const db = getDb();
  const now = nowIso();
  const stale = db.prepare("SELECT * FROM jobs WHERE state='RUNNING' AND lease_expires_at < ?").all(now) as JobRow[];
  for (const j of stale) {
    const def = JOB_TYPES[j.type];
    let state: JobState;
    let msg: string;
    let se = j.side_effect_state;
    if (def?.sideEffect && j.side_effect_state === "REQUESTED") {
      se = "AMBIGUOUS";
      if (j.type === "PUBLISH") {
        state = "RETRYING";
        msg = "Worker lost during publish. Remote state will be reconciled before any retry.";
      } else {
        state = "NEEDS_ATTENTION";
        msg = "Worker lost after an external side effect was requested. Operator review required.";
      }
    } else if (j.attempts < j.max_attempts) {
      state = "RETRYING";
      msg = "Worker lease expired — recovered and scheduled for retry";
    } else {
      state = "FAILED";
      msg = "Worker lease expired and attempts are exhausted";
    }
    const r = db
      .prepare("UPDATE jobs SET state=?, side_effect_state=?, lease_owner=NULL, lease_expires_at=NULL, run_after=?, updated_at=? WHERE id=? AND state='RUNNING' AND lease_expires_at < ?")
      .run(state, se, now, now, j.id, now);
    if (r.changes) {
      jobEvent(j.id, state, msg);
      audit({ actor: "worker", action: "job.recovered", subjectType: "job", subjectId: j.id, brandId: j.brand_id, summary: `${j.id}: ${msg}`, level: "WARN" });
    }
  }
  return stale.length;
}

const CANCELLABLE: JobState[] = ["QUEUED", "BLOCKED", "RETRYING", "NEEDS_ATTENTION"];

export function cancelJob(jobId: string, actor: string) {
  const j = getJob(jobId);
  const def = JOB_TYPES[j.type];
  const safeRunning = j.state === "RUNNING" && !def?.sideEffect;
  if (!CANCELLABLE.includes(j.state) && !safeRunning)
    throw new AppError("NOT_CANCELLABLE", `Job is ${j.state}${j.state === "RUNNING" ? " with an external side effect in flight" : ""}; it cannot be cancelled safely.`);
  getDb().prepare("UPDATE jobs SET state='CANCELLED', lease_owner=NULL, finished_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), jobId);
  jobEvent(jobId, "CANCELLED", `Cancelled by ${actor}`);
  audit({ actor, action: "job.cancel", subjectType: "job", subjectId: jobId, brandId: j.brand_id, summary: `Job ${jobId} cancelled` });
}

export function retryJob(jobId: string, actor: string) {
  const j = getJob(jobId);
  if (!["FAILED", "NEEDS_ATTENTION", "CANCELLED"].includes(j.state)) throw new AppError("NOT_RETRYABLE", `Job is ${j.state}.`);
  const reasons = blockReasons(j);
  const state: JobState = reasons.length ? "BLOCKED" : "QUEUED";
  getDb()
    .prepare("UPDATE jobs SET state=?, blocked_reason_json=?, max_attempts=attempts+1, run_after=?, finished_at=NULL, updated_at=? WHERE id=?")
    .run(state, reasons.length ? JSON.stringify(reasons) : null, nowIso(), nowIso(), jobId);
  jobEvent(jobId, state, `Retry requested by ${actor}${j.side_effect_state === "AMBIGUOUS" ? " — remote state will be reconciled first" : ""}`);
  audit({ actor, action: "job.retry", subjectType: "job", subjectId: jobId, brandId: j.brand_id, summary: `Job ${jobId} retry → ${state}` });
}

export function recordUsage(jobId: string, usage: unknown, cost: number | null) {
  getDb().prepare("UPDATE jobs SET usage_json=?, cost_estimate=COALESCE(cost_estimate,0)+COALESCE(?,0), updated_at=? WHERE id=?").run(JSON.stringify(usage), cost, nowIso(), jobId);
}

export function workerStatus(): { workerId: string | null; lastBeat: string | null; alive: boolean } {
  const r = getDb().prepare("SELECT value, updated_at FROM settings WHERE key='worker_heartbeat'").get() as { value: string; updated_at: string } | undefined;
  if (!r) return { workerId: null, lastBeat: null, alive: false };
  const v = parseJson<{ workerId: string }>(r.value, { workerId: "?" });
  return { workerId: v.workerId, lastBeat: r.updated_at, alive: Date.now() - new Date(r.updated_at).getTime() < 30_000 };
}
