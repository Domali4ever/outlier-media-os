"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, changePassword, login, logout, setupOperator } from "@/core/auth";
import * as brand from "@/core/brand";
import * as commercial from "@/core/commercial";
import * as content from "@/core/content";
import { connectIntegration, disableIntegration, pauseIntegration, resumeIntegration } from "@/core/integrations";
import { cancelJob, createJob, retryJob } from "@/core/jobs";
import { addCost, importPerformanceCsv } from "@/core/performance";
import { revokePolicy, setPolicy } from "@/core/policies";
import { backupNow, exportToDir, importBundle } from "@/core/portability";
import { decideRecommendation, getRecommendation, refreshRecommendations } from "@/core/recommendations";
import { pausedJobTypes, setSetting } from "@/core/settings";
import { recordCheckIn } from "@/core/today";
import { audit } from "@/core/audit";
import { AppError } from "@/core/util";
import { addMcpServer, discoverTools, setAllowlist, setMcpState } from "@/adapters/mcp";
import { testIntegration } from "@/adapters/registry";
import { boot, requireOperator } from "@/lib/session";
import type { ClaimType, FactStatus, Intent, Risk, Stage } from "@/core/types";

export interface ActionState {
  ok: boolean;
  message: string;
  jobId?: string;
  redirect?: string;
  details?: unknown;
  at?: number;
}

const s = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};
const opt = (f: FormData, k: string) => {
  const v = s(f, k).trim();
  return v === "" ? undefined : v;
};
async function file(f: FormData, k: string): Promise<{ name: string; data: Buffer } | undefined> {
  const v = f.get(k);
  if (v && typeof v === "object" && "arrayBuffer" in v && (v as File).size > 0) {
    const fl = v as File;
    return { name: fl.name, data: Buffer.from(await fl.arrayBuffer()) };
  }
  return undefined;
}

/* ------------------------------------------------------------------ auth */

export async function authAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  boot();
  try {
    const op = s(f, "op");
    const pw = s(f, "password");
    if (op === "setup") {
      if (pw !== s(f, "confirm")) return { ok: false, message: "Passwords do not match." };
      setupOperator(pw);
    }
    const h = await headers();
    const { token, expires } = login(pw, h.get("x-forwarded-for") ?? "local", h.get("user-agent"));
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "1",
      path: "/",
      expires: new Date(expires),
    });
  } catch (e) {
    return { ok: false, message: e instanceof AppError ? e.message : "Sign-in failed." };
  }
  redirect("/");
}

export async function logoutAction() {
  const c = await cookies();
  logout(c.get(SESSION_COOKIE)?.value);
  c.delete(SESSION_COOKIE);
  redirect("/login");
}

/* ------------------------------------------------------- operator actions */

/**
 * Single dispatcher for every operator mutation. Authentication is checked here; permissions,
 * approvals and workflow gates are enforced again inside the core services, so the same rules
 * apply to any direct request.
 */
export async function act(_prev: ActionState, f: FormData): Promise<ActionState> {
  let actor: "operator";
  try {
    actor = await requireOperator();
  } catch {
    return { ok: false, message: "Your session expired. Sign in again.", redirect: "/login", at: Date.now() };
  }
  const op = s(f, "op");
  const brandId = opt(f, "brandId") ?? brand.selectedBrandId();
  try {
    const r = await handle(op, f, actor, brandId);
    revalidatePath("/", "layout");
    return { ok: true, at: Date.now(), ...r };
  } catch (e) {
    const msg = e instanceof AppError ? e.message : (e as Error).message || "Action failed.";
    if (!(e instanceof AppError)) audit({ actor, action: "action.error", subjectType: "action", subjectId: op, summary: `Action ${op} failed: ${msg}`, level: "ERROR" });
    return { ok: false, message: msg, details: e instanceof AppError ? e.details : undefined, at: Date.now() };
  }
}

async function handle(op: string, f: FormData, actor: "operator", brandId: string): Promise<Omit<ActionState, "ok">> {
  const id = s(f, "id");
  switch (op) {
    /* TODAY */
    case "checkin":
      recordCheckIn(actor);
      return { message: "Check-in recorded. Summaries now start from this moment." };
    case "select_brand":
      brand.selectBrand(id, actor);
      return { message: "Brand selected." };
    case "run": {
      const type = s(f, "jobType");
      const c = opt(f, "contentId") ? content.getContent(s(f, "contentId")) : null;
      const { job, created } = createJob({ type, brandId, contentId: c?.id ?? null, revisionId: c?.current_revision_id ?? null, actor, rerun: true, input: opt(f, "instruction") ? { instruction: s(f, "instruction") } : {} });
      return { message: `Job ${job.id} ${created ? "created" : "already active"} — ${job.state}.`, jobId: job.id };
    }
    case "rec_decide": {
      const r = decideRecommendation(id, s(f, "decision") === "APPROVED" ? "APPROVED" : "REJECTED", actor);
      return { message: r.followUp ?? "Decision recorded." };
    }
    case "rec_fix": {
      const r = getRecommendation(id);
      if (r.subject_type !== "content") throw new AppError("NOT_APPLICABLE", "FIX WITH AI applies to content recommendations only.");
      const c = content.getContent(r.subject_id);
      const { job } = createJob({ type: "REVISE", brandId: c.brand_id, contentId: c.id, revisionId: c.current_revision_id, actor, rerun: true, input: { instruction: `${r.title}. ${r.reason}` } });
      return { message: `Revision job ${job.id} — ${job.state}.`, jobId: job.id };
    }
    case "rec_refresh": {
      const r = refreshRecommendations(brandId, actor);
      return { message: `${r.created} new, ${r.superseded} superseded.` };
    }

    /* CONTENT */
    case "content_create": {
      const cid = content.createContent(brandId, { title: s(f, "title"), pillarId: opt(f, "pillarId") ?? null, buyerIntent: (opt(f, "buyerIntent") as Intent) ?? null, risk: (opt(f, "risk") as Risk) ?? "MEDIUM", contentType: opt(f, "contentType") ?? "article" }, actor);
      return { message: `Created ${cid}.`, redirect: `/pipeline/${cid}` };
    }
    case "content_meta":
      content.updateContentMeta(
        id,
        {
          pillarId: f.has("pillarId") ? opt(f, "pillarId") ?? null : undefined,
          contentType: opt(f, "contentType"),
          buyerIntent: f.has("buyerIntent") ? ((opt(f, "buyerIntent") as Intent) ?? null) : undefined,
          risk: opt(f, "risk") as Risk | undefined,
          commercialDecision: opt(f, "commercialDecision") as "UNDECIDED" | "OFFER" | "NO_OFFER" | undefined,
          targetOfferId: f.has("targetOfferId") ? opt(f, "targetOfferId") ?? null : undefined,
        },
        actor,
      );
      return { message: "Details saved." };
    case "content_save": {
      const r = content.saveRevision(id, { title: opt(f, "title"), body: f.has("body") ? s(f, "body") : undefined, researchNotes: f.has("researchNotes") ? s(f, "researchNotes") : undefined, changeNote: s(f, "changeNote") || "Operator edit" }, actor);
      return { message: r.invalidated ? `Saved revision ${r.number}. ${r.invalidated} approval(s) invalidated.` : `Saved revision ${r.number}.` };
    }
    case "content_move":
      content.moveStage(id, s(f, "stage") as Stage, actor);
      return { message: `Moved to ${s(f, "stage")}.` };
    case "content_return":
      content.returnForRevision(id, actor, s(f, "note"));
      return { message: "Returned to SCRIPT for revision." };
    case "content_retire":
      content.retireContent(id, actor);
      return { message: "Retired. You can restore it from the pipeline (show retired)." };
    case "content_restore":
      content.restoreContent(id, actor);
      return { message: "Restored." };
    case "content_qa": {
      const r = content.runQaNow(id, actor);
      return { message: `Deterministic QA: ${r.result}. Structural checks only — factual/medical review is separate.` };
    }
    case "content_human_review":
      content.recordHumanReview(id, s(f, "result") === "PASS" ? "PASS" : "FAIL", s(f, "notes"), actor);
      return { message: "Human review recorded against the current revision." };
    case "content_approve":
      content.approveContent(id, actor, s(f, "note"), opt(f, "revisionId"));
      return { message: "Approved. The approval is bound to this revision, destination and offer." };
    case "content_reject":
      content.rejectContent(id, actor, s(f, "note"));
      return { message: "Rejected and returned to SCRIPT." };
    case "content_publish": {
      const { job } = content.requestPublish(id, actor);
      return { message: `Publish job ${job.id} — ${job.state}.`, jobId: job.id };
    }
    case "content_manual_publish":
      content.recordManualPublication(id, { url: s(f, "url"), proofNote: s(f, "proofNote"), file: await file(f, "file") }, actor);
      return { message: "Manual publication recorded with evidence." };
    case "evidence_add":
      content.addEvidence(
        {
          brandId,
          contentId: opt(f, "contentId") ?? null,
          kind: (opt(f, "kind") as "WEB_SOURCE" | "DOCUMENT" | "MANUAL_NOTE") ?? "MANUAL_NOTE",
          url: opt(f, "url") ?? null,
          title: s(f, "title"),
          excerpt: s(f, "excerpt"),
          checkedAt: opt(f, "checkedAt") ?? null,
          file: await file(f, "file"),
        },
        actor,
      );
      return { message: "Evidence attached." };
    case "claim_add":
      content.addClaim(id, { text: s(f, "text"), claimType: s(f, "claimType") as ClaimType }, actor);
      return { message: "Claim recorded as UNVERIFIED." };
    case "claim_status":
      content.setClaimStatus(s(f, "claimId"), s(f, "status") as FactStatus, opt(f, "evidenceId") ?? null, actor, opt(f, "note"));
      return { message: "Claim updated." };
    case "drive_import": {
      const { job } = createJob({ type: "DRIVE_IMPORT", brandId, contentId: opt(f, "contentId") ?? null, actor, rerun: true, input: { fileRef: s(f, "fileRef"), contentId: opt(f, "contentId") } });
      return { message: `Drive import job ${job.id} — ${job.state}.`, jobId: job.id };
    }

    /* BRAND */
    case "brand_update":
      brand.updateBrand(
        brandId,
        {
          name: opt(f, "name"),
          market: opt(f, "market"),
          language: opt(f, "language"),
          currency: opt(f, "currency")?.toUpperCase(),
          objective: f.has("objective") ? s(f, "objective") : undefined,
          description: f.has("description") ? s(f, "description") : undefined,
          settings: f.has("affiliateDisclosure")
            ? {
                affiliateDisclosure: s(f, "affiliateDisclosure"),
                restrictedPhrases: s(f, "restrictedPhrases").split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean),
                minBodyChars: Math.max(200, Number(s(f, "minBodyChars")) || 600),
              }
            : undefined,
        },
        actor,
      );
      return { message: "Brand saved." };
    case "brand_status":
      brand.setBrandStatus(brandId, s(f, "status") as "ACTIVE", actor);
      return { message: `Brand is now ${s(f, "status")}.` };
    case "pillar_add":
      brand.addPillar(brandId, s(f, "name"), actor);
      return { message: "Pillar added." };
    case "pillar_rename":
      brand.renamePillar(id, s(f, "name"), actor);
      return { message: "Pillar renamed." };
    case "avatar_update":
      brand.updateAvatar(
        id,
        {
          name: s(f, "name"),
          role: s(f, "role"),
          bio: s(f, "bio"),
          personality: s(f, "personality"),
          voice_tone: s(f, "voice_tone"),
          ai_disclosure: s(f, "ai_disclosure"),
          expertise_boundary: s(f, "expertise_boundary"),
          visual_ref: s(f, "visual_ref"),
          voice_ref: s(f, "voice_ref"),
          restricted_claims: s(f, "restricted_claims").split(/\r?\n/),
        },
        actor,
      );
      return { message: "Avatar saved. Any previous approval was invalidated." };
    case "avatar_approve":
      brand.approveAvatar(id, actor, s(f, "note"));
      return { message: "Avatar configuration approved." };
    case "brand_clone": {
      const r = brand.cloneBrand(brandId, { name: s(f, "name"), market: s(f, "market"), language: s(f, "language"), currency: s(f, "currency").toUpperCase() }, actor);
      brand.selectBrand(r.brandId, actor);
      return { message: `Clone ${r.brandId} created in DRAFT and selected.` };
    }
    case "program_add":
      commercial.addProgram(brandId, { name: s(f, "name"), network: s(f, "network"), url: opt(f, "url"), notes: s(f, "notes") }, actor);
      return { message: "Program recorded as DISCOVERED." };
    case "fact_set":
      commercial.setFact(id, s(f, "criterion"), { value: s(f, "value"), sourceUrl: opt(f, "sourceUrl"), checkedAt: opt(f, "checkedAt"), evidence: s(f, "evidence"), status: s(f, "status") as FactStatus }, actor);
      return { message: "Fact saved." };
    case "program_qualify":
      commercial.qualifyProgram(id, actor);
      return { message: "Program qualified." };
    case "program_status":
      commercial.setProgramStatus(id, s(f, "status") as "DISQUALIFIED", actor);
      return { message: "Program status updated." };
    case "account_status":
      commercial.setAccountStatus(id, s(f, "status") as "APPROVED", actor, s(f, "note"));
      return { message: "Account status recorded." };
    case "offer_add":
      commercial.addOffer(brandId, { programId: s(f, "programId"), name: s(f, "name"), productUrl: opt(f, "productUrl"), affiliateUrl: opt(f, "affiliateUrl"), disclosure: s(f, "disclosure"), commissionText: s(f, "commissionText") }, actor);
      return { message: "Offer added (DRAFT, link inactive)." };
    case "offer_update":
      commercial.updateOffer(id, { name: opt(f, "name"), product_url: opt(f, "productUrl"), affiliate_url: opt(f, "affiliateUrl"), disclosure: f.has("disclosure") ? s(f, "disclosure") : undefined, commission_text: f.has("commissionText") ? s(f, "commissionText") : undefined }, actor);
      return { message: "Offer saved." };
    case "offer_validity":
      commercial.setOfferValidity(id, s(f, "status") as "VALID", actor);
      return { message: "Offer validity updated." };
    case "offer_link":
      commercial.setLinkStatus(id, s(f, "status") === "ACTIVE" ? "ACTIVE" : "INACTIVE", actor);
      return { message: `Live link ${s(f, "status")}.` };
    case "find_offers": {
      const { job } = createJob({ type: "FIND_OFFERS", brandId, actor, rerun: true, input: { focus: opt(f, "focus") } });
      return { message: `Find offers job ${job.id} — ${job.state}.`, jobId: job.id };
    }
    case "perf_import": {
      const fl = await file(f, "csv");
      if (!fl) throw new AppError("BAD_INPUT", "Choose a CSV file.");
      const r = importPerformanceCsv(brandId, s(f, "source") || "csv_import", fl.data.toString("utf8"), actor, s(f, "apply") !== "1");
      if (r.errors.length) return { message: `Import blocked: ${r.errors.slice(0, 5).join(" ")}${r.errors.length > 5 ? " …" : ""}`, details: r };
      return { message: r.dryRun ? `Dry run OK: ${r.valid} valid row(s). Import again with “apply” to store them.` : `Imported ${r.inserted}; ${r.duplicates} duplicate(s) skipped.`, details: r };
    }
    case "cost_add":
      addCost({ brandId, category: s(f, "category") || "operating", amount: Number(s(f, "amount")), currency: s(f, "currency").toUpperCase(), isEstimate: false, source: "manual", note: s(f, "note"), incurredAt: opt(f, "incurredAt") ? new Date(s(f, "incurredAt")).toISOString() : undefined });
      audit({ actor, action: "cost.add", subjectType: "brand", subjectId: brandId, brandId, summary: `Cost recorded: ${s(f, "amount")} ${s(f, "currency").toUpperCase()} (${s(f, "category") || "operating"})` });
      return { message: "Cost recorded." };

    /* SYSTEM */
    case "int_connect": {
      const r = connectIntegration(id, actor);
      if (r.missing.length) return { message: `Missing configuration: ${r.missing.join(", ")}. Add them to .env.local (see docs/CONNECTIONS.md), then CONNECT again.` };
      const t = await testIntegration(id, actor);
      return { message: t.ok ? `Connected — ${t.detail}` : `Configuration found but the test failed: ${t.detail}` };
    }
    case "int_test": {
      const t = await testIntegration(id, actor);
      return { message: t.ok ? `Test passed — ${t.detail}` : `Test failed — ${t.detail}` };
    }
    case "int_pause":
      pauseIntegration(id, actor);
      return { message: "Paused. Dependent jobs will block." };
    case "int_disable":
      disableIntegration(id, actor);
      return { message: "Disabled." };
    case "int_resume":
      resumeIntegration(id, actor);
      return { message: "Resumed — run TEST to reconnect." };
    case "mcp_add":
      addMcpServer(
        {
          name: s(f, "name"),
          transport: s(f, "transport") === "stdio" ? "stdio" : "http",
          url: opt(f, "url"),
          command: opt(f, "command"),
          args: s(f, "args").split(/\s+/).filter(Boolean),
          headerRefs: opt(f, "authHeaderRef") ? { Authorization: s(f, "authHeaderRef") } : {},
          envRefs: Object.fromEntries(s(f, "envRefs").split(/[,\s]+/).filter(Boolean).map((n) => [n, n])),
        },
        actor,
      );
      return { message: "MCP server registered. Run DISCOVER to list its tools." };
    case "mcp_discover": {
      const tools = await discoverTools(id, actor);
      return { message: `${tools.length} tool(s) discovered. None are callable until you allowlist them.` };
    }
    case "mcp_allow":
      setAllowlist(id, s(f, "tool"), s(f, "level") === "" ? null : Number(s(f, "level")), actor);
      return { message: "Allowlist updated." };
    case "mcp_state":
      setMcpState(id, s(f, "state") as "PAUSED", actor);
      return { message: "MCP server state updated." };
    case "job_cancel":
      cancelJob(id, actor);
      return { message: "Job cancelled." };
    case "job_retry":
      retryJob(id, actor);
      return { message: "Retry requested.", jobId: id };
    case "pause_all":
    case "resume_all":
      setSetting("system_paused", op === "pause_all");
      audit({ actor, action: op === "pause_all" ? "system.pause" : "system.resume", subjectType: "system", subjectId: "automation", summary: op === "pause_all" ? "All automation paused" : "Automation resumed" });
      return { message: op === "pause_all" ? "All automation paused." : "Automation resumed." };
    case "pause_type":
    case "resume_type": {
      const set = new Set(pausedJobTypes());
      op === "pause_type" ? set.add(s(f, "jobType")) : set.delete(s(f, "jobType"));
      setSetting("paused_job_types", [...set]);
      audit({ actor, action: op, subjectType: "workflow", subjectId: s(f, "jobType"), summary: `Workflow ${s(f, "jobType")} ${op === "pause_type" ? "paused" : "resumed"}` });
      return { message: "Workflow updated." };
    }
    case "budget_set": {
      const amount = Number(s(f, "amount"));
      if (!(amount > 0)) throw new AppError("BAD_INPUT", "Cap must be a positive amount.");
      const cur = s(f, "currency").toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) throw new AppError("BAD_INPUT", "Currency must be an ISO code.");
      setPolicy(brandId, "budget", { amount, currency: cur, period: "month" }, actor);
      return { message: `Monthly AI/external cap set to ${amount.toFixed(2)} ${cur}.` };
    }
    case "recurring_set": {
      const n = Math.floor(Number(s(f, "maxPerWeek")));
      if (!(n >= 1 && n <= 50)) throw new AppError("BAD_INPUT", "Max per week must be 1–50.");
      setPolicy(brandId, "recurring_publication", { destination: "publish.primary", maxPerWeek: n }, actor);
      return { message: `Recurring publication policy active: up to ${n} approved item(s)/week after the first manual publication.` };
    }
    case "recurring_revoke":
      revokePolicy(brandId, "recurring_publication", actor);
      return { message: "Recurring publication revoked." };
    case "human_review_route":
      setSetting("allow_human_editorial_review", s(f, "allow") === "1");
      audit({ actor, action: "settings.human_review", subjectType: "system", subjectId: "human_review", summary: `Human editorial review route ${s(f, "allow") === "1" ? "enabled" : "disabled"}` });
      return { message: "Setting saved." };
    case "backup_now": {
      const r = await backupNow(actor);
      return { message: `Backup written to ${r.dir}` };
    }
    case "export_now": {
      const r = exportToDir(actor);
      return { message: `Export written to ${r.dir}` };
    }
    case "import_bundle": {
      const fl = await file(f, "bundle");
      if (!fl) throw new AppError("BAD_INPUT", "Choose an export data.json.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(fl.data.toString("utf8"));
      } catch {
        throw new AppError("BAD_IMPORT", "File is not valid JSON.");
      }
      const r = importBundle(parsed, { dryRun: s(f, "apply") !== "1", asLegacy: s(f, "legacy") === "1", actor });
      const total = Object.values(r.counts).reduce((a, c) => a + c.new, 0);
      if (!r.ok) return { message: `Import refused: ${r.errors.join(" ")}`, details: r };
      return { message: r.dryRun ? `Dry run OK: ${total} new row(s) would be added; existing IDs are never overwritten.` : `Imported ${total} new row(s).`, details: r };
    }
    case "password_change":
      changePassword(s(f, "current"), s(f, "next"));
      return { message: "Password changed. Sign in again.", redirect: "/login" };
  }
  throw new AppError("UNKNOWN_OP", `Unknown action ${op}.`);
}
