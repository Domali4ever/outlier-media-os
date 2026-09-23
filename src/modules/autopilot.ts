import { checkTransition, getContent, getRevision, moveStage, runQaNow } from "@/core/content";
import { getJob, type JobRow } from "@/core/jobs";
import { latestQa } from "@/core/qa";
import { AppError } from "@/core/util";
import { JobContext } from "./context";
import { runEditorialQa, runScript } from "./writing";
import { runResearch as runResearchJob } from "./research";

function latestResult(contentId: string, revisionId: string, kind: "DETERMINISTIC" | "AI_EDITORIAL") {
  return latestQa(contentId, revisionId, kind)?.result;
}

function currentContext(ctx: JobContext, revisionId: string) {
  return new JobContext({ ...getJob(ctx.job.id), revision_id: revisionId } as JobRow, ctx.workerId);
}

export async function runAutopilotPrepare(ctx: JobContext) {
  let item = getContent(ctx.job.content_id!);

  if (item.stage === "IDEA" || (item.stage === "RESEARCH" && item.research_status !== "RESEARCHED")) {
    ctx.progress("Preparing research");
    await runResearchJob(ctx);
    item = getContent(item.id);
  }

  const revision = getRevision(item.current_revision_id);
  if ((item.stage === "RESEARCH" || item.stage === "IDEA") && !revision.body.trim()) {
    ctx.progress("Preparing script");
    await runScript(ctx);
    item = getContent(item.id);
  }

  let currentRevision = getRevision(item.current_revision_id);
  if (latestResult(item.id, currentRevision.id, "DETERMINISTIC") !== "PASS") {
    ctx.progress("Running deterministic QA");
    const qa = runQaNow(item.id, "worker");
    if (qa.result !== "PASS") throw new AppError("AUTOPILOT_QA", "Deterministic QA found issues that need operator review.", 409, qa.findings);
    item = getContent(item.id);
    currentRevision = getRevision(item.current_revision_id);
  }

  if (latestResult(item.id, currentRevision.id, "AI_EDITORIAL") !== "PASS") {
    ctx.progress("Running editorial review");
    await runEditorialQa(currentContext(ctx, currentRevision.id));
    item = getContent(item.id);
    currentRevision = getRevision(item.current_revision_id);
    if (latestResult(item.id, currentRevision.id, "AI_EDITORIAL") !== "PASS")
      throw new AppError("AUTOPILOT_EDITORIAL", "Editorial review found issues that need operator review.", 409);
  }

  if (item.stage === "QA") {
    const reasons = checkTransition(item, "APPROVAL");
    if (reasons.length) throw new AppError("AUTOPILOT_NOT_READY", reasons.join(" "), 409, reasons);
    moveStage(item.id, "APPROVAL", "worker", "Assisted autopilot preparation complete");
  }

  return { stage: "APPROVAL", humanAction: "Review the current revision and approve it before publishing." };
}
