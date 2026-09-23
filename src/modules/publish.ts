import { createPost, findBySlug, slugFor, toHtml } from "@/adapters/wordpress";
import { commercialReadiness } from "@/core/commercial";
import { activeContentApproval, getContent, getRevision, recordProviderPublication } from "@/core/content";
import { getConfigValue } from "@/core/settings";
import { AppError } from "@/core/util";
import { JobContext } from "./context";

/**
 * PUBLISH. Rechecks every gate immediately before the side effect, reconciles remote state
 * before any retry of a possibly-accepted request, and only records PUBLISHED on a confirmed receipt.
 */
export async function runPublish(ctx: JobContext) {
  const item = getContent(ctx.job.content_id!);
  if (item.current_revision_id !== ctx.job.revision_id)
    throw new AppError("REVISION_CHANGED", "The content changed after this publish job was approved. Approve the new revision and publish again.");
  const approval = activeContentApproval(item);
  if (!approval || approval.id !== ctx.job.approval_id)
    throw new AppError("APPROVAL_INVALID", "The approval bound to this job is no longer active for the current revision, destination and offer.");
  if (item.stage !== "READY") throw new AppError("NOT_READY", `Content is ${item.stage}, not READY.`);
  const cm = commercialReadiness(item);
  if (!cm.ok) throw new AppError("COMMERCIAL_BLOCKED", cm.reasons.join(" "));

  const rev = getRevision(item.current_revision_id);
  const slug = slugFor(item.id, rev.number, rev.title);

  if (ctx.job.side_effect_state !== "NONE") {
    ctx.progress("Reconciling remote state before retry");
    const existing = await findBySlug(slug);
    if (existing) {
      if (existing.status !== "publish") throw new AppError("REMOTE_NOT_PUBLISHED", `A post with this slug exists in WordPress with status “${existing.status}”. Review it in WordPress before retrying.`);
      const pubId = recordProviderPublication({ contentId: item.id, revisionId: rev.id, approvalId: approval.id, destination: item.destination, remoteId: String(existing.id), remoteUrl: existing.link, receipt: { reconciled: true, post: existing }, jobId: ctx.job.id });
      ctx.sideEffect("CONFIRMED");
      return { publicationId: pubId, remoteId: existing.id, url: existing.link, reconciled: true };
    }
  }

  const status = getConfigValue("WP_POST_STATUS", "publish") === "draft" ? "draft" : "publish";
  if (status === "draft") throw new AppError("DRAFT_MODE", "WP_POST_STATUS=draft creates drafts, which are not publications. Set it to publish or record a manual publication after publishing in WordPress.");
  ctx.progress("Sending post to WordPress");
  ctx.sideEffect("REQUESTED");
  const post = await createPost({ title: rev.title, html: toHtml(rev.body), slug, status });
  if (post.status !== "publish") throw new AppError("NOT_CONFIRMED", `WordPress accepted the post but reports status “${post.status}”, not published.`);
  const pubId = recordProviderPublication({ contentId: item.id, revisionId: rev.id, approvalId: approval.id, destination: item.destination, remoteId: String(post.id), remoteUrl: post.link, receipt: { id: post.id, link: post.link, status: post.status, slug: post.slug, modified_gmt: post.modified_gmt }, jobId: ctx.job.id });
  ctx.sideEffect("CONFIRMED");
  return { publicationId: pubId, remoteId: post.id, url: post.link };
}
