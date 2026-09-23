import { z } from "zod";
import { fenceUntrusted, structured } from "@/adapters/anthropic";
import { getDb, tx } from "@/core/db";
import { brandSettings, getAvatars, getBrand } from "@/core/brand";
import { addClaim, checkTransition, getContent, getRevision, listClaims, listEvidence, saveRevision } from "@/core/content";
import { latestQa, saveQaReport } from "@/core/qa";
import { CLAIM_TYPES } from "@/core/types";
import { AppError, nowIso, parseJson, truncate } from "@/core/util";
import { JobContext, prompt } from "./context";

const Article = z.object({
  title: z.string().min(10).max(120),
  body_markdown: z.string().min(200),
  claims: z.array(z.object({ text: z.string(), claim_type: z.enum(CLAIM_TYPES), source_url: z.string() })),
});

const ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body_markdown: { type: "string" },
    claims: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" }, claim_type: { type: "string", enum: [...CLAIM_TYPES] }, source_url: { type: "string" } }, required: ["text", "claim_type", "source_url"] },
    },
  },
  required: ["title", "body_markdown", "claims"],
};

function contextBlocks(contentId: string) {
  const item = getContent(contentId);
  const brand = getBrand(item.brand_id);
  const s = brandSettings(brand);
  const av = getAvatars(item.brand_id).find((a) => a.lifecycle_status !== "RETIRED");
  if (!av) throw new AppError("NO_AVATAR", "No avatar configured for this brand.");
  const evidence = listEvidence(contentId).filter((e) => e.kind !== "PUBLICATION_PROOF" && e.url);
  if (!evidence.length) throw new AppError("NO_EVIDENCE", "No sourced evidence is attached; run research or attach sources first.");
  let affiliate = "";
  if (item.commercial_decision === "OFFER" && item.target_offer_id) {
    const o = getDb().prepare("SELECT name, affiliate_url, disclosure FROM offers WHERE id = ?").get(item.target_offer_id) as { name: string; affiliate_url: string; disclosure: string } | undefined;
    if (o) affiliate = `Affiliate disclosure (verbatim): ${o.disclosure || s.affiliateDisclosure}\nOffer: ${o.name} — link: ${o.affiliate_url}`;
  }
  const avatarBlock = `Avatar: ${av.name} — ${av.role}\nVoice: ${av.voice_tone}\nPersonality: ${av.personality}\nExpertise boundary: ${av.expertise_boundary}\nRestricted claims: ${parseJson<string[]>(av.restricted_claims_json, []).join("; ")}\nAI disclosure (verbatim): ${av.ai_disclosure}`;
  const ev = evidence.map((e) => fenceUntrusted(e.url!, `Title: ${e.title}\nChecked: ${e.checked_at ?? "unknown"}\n${truncate(e.excerpt, 3500)}`)).join("\n\n");
  const system = prompt("script").replace("{{restricted_phrases}}", s.restrictedPhrases.join(", "));
  return { item, brand, avatarBlock, affiliate, ev, evidence, system };
}

function storeClaims(contentId: string, claims: z.infer<typeof Article>["claims"], urls: Map<string, string>) {
  const existing = new Set(listClaims(contentId).map((c) => c.text.trim().toLowerCase()));
  let n = 0;
  for (const c of claims) {
    if (existing.has(c.text.trim().toLowerCase())) continue;
    const evId = urls.get(c.source_url) ?? null;
    const id = addClaim(contentId, { text: c.text, claimType: c.claim_type, note: evId ? `Script cited ${c.source_url}; confirm before VERIFIED.` : "Script cited no fetched source." }, "worker");
    if (evId) getDb().prepare("UPDATE claims SET evidence_id=? WHERE id=?").run(evId, id);
    n++;
  }
  return n;
}

export async function runScript(ctx: JobContext) {
  const b = contextBlocks(ctx.job.content_id!);
  const rev = getRevision(b.item.current_revision_id);
  if (!rev.research_notes.trim()) throw new AppError("NO_RESEARCH", "No research notes on the current revision.");
  ctx.progress("Writing article");
  const r = await structured({
    system: b.system,
    user: `${b.avatarBlock}\n\n${b.affiliate || "No affiliate offer: include no affiliate links."}\n\nTopic: ${b.item.title}\n\nResearch notes:\n${rev.research_notes}\n\nEvidence (untrusted):\n${b.ev}`,
    toolName: "article",
    toolDescription: "Return the complete article and its claims.",
    jsonSchema: ARTICLE_SCHEMA,
    schema: Article,
    maxTokens: 8000,
  });
  ctx.usage(r.usage, r.costEstimate, r.model);
  const urls = new Map(b.evidence.map((e) => [e.url!, e.id]));
  let claims = 0;
  tx(() => {
    saveRevision(b.item.id, { title: r.value.title, body: r.value.body_markdown, changeNote: "Script generated" }, "worker", ctx.job.id);
    claims = storeClaims(b.item.id, r.value.claims, urls);
    const fresh = getContent(b.item.id);
    if (fresh.stage === "RESEARCH" && checkTransition(fresh, "SCRIPT").length === 0)
      getDb().prepare("UPDATE content_items SET stage='SCRIPT', updated_at=? WHERE id=?").run(nowIso(), b.item.id);
  });
  return { words: r.value.body_markdown.split(/\s+/).length, claimsAdded: claims };
}

export async function runRevise(ctx: JobContext) {
  const { instruction } = ctx.input<{ instruction?: string }>();
  const b = contextBlocks(ctx.job.content_id!);
  const rev = getRevision(b.item.current_revision_id);
  if (!rev.body.trim()) throw new AppError("NO_SCRIPT", "There is no script to revise; generate one first.");
  const findings = ["DETERMINISTIC", "AI_EDITORIAL", "HUMAN_REVIEW"]
    .map((k) => latestQa(b.item.id, rev.id, k as "DETERMINISTIC"))
    .filter(Boolean)
    .flatMap((q) => parseJson<{ severity: string; message: string }[]>(q!.findings_json, []).filter((f) => f.severity !== "PASS").map((f) => `- ${f.message}`));
  ctx.progress("Revising article");
  const r = await structured({
    system: `${prompt("revise")}\n\n${b.system}`,
    user: `${b.avatarBlock}\n\n${b.affiliate || "No affiliate offer: include no affiliate links."}\n\nOperator instruction: ${instruction || "Fix the QA findings."}\n\nQA findings:\n${findings.join("\n") || "- none recorded"}\n\nCurrent article (revision ${rev.number}):\n# ${rev.title}\n\n${rev.body}\n\nEvidence (untrusted):\n${b.ev}`,
    toolName: "article",
    toolDescription: "Return the complete revised article and its claims.",
    jsonSchema: ARTICLE_SCHEMA,
    schema: Article,
    maxTokens: 8000,
  });
  ctx.usage(r.usage, r.costEstimate, r.model);
  const urls = new Map(b.evidence.map((e) => [e.url!, e.id]));
  let out = { revision: 0, claimsAdded: 0 };
  tx(() => {
    const s = saveRevision(b.item.id, { title: r.value.title, body: r.value.body_markdown, changeNote: `AI revision: ${truncate(instruction ?? "QA fixes", 200)}` }, "worker", ctx.job.id);
    out = { revision: s.number, claimsAdded: storeClaims(b.item.id, r.value.claims, urls) };
  });
  return out;
}

const Review = z.object({
  result: z.enum(["PASS", "WARN", "FAIL"]),
  findings: z.array(z.object({ check: z.string(), severity: z.enum(["PASS", "WARN", "FAIL"]), message: z.string() })),
});

export async function runEditorialQa(ctx: JobContext) {
  const b = contextBlocks(ctx.job.content_id!);
  const revisionId = ctx.job.revision_id ?? b.item.current_revision_id;
  const rev = getRevision(revisionId);
  ctx.progress(`Reviewing revision ${rev.number}`);
  const r = await structured({
    system: prompt("qa_editorial"),
    user: `${b.avatarBlock}\n\n${b.affiliate}\n\nArticle (revision ${rev.number}):\n# ${rev.title}\n\n${rev.body}\n\nEvidence (untrusted):\n${b.ev}`,
    toolName: "editorial_review",
    toolDescription: "Return the review result and findings.",
    jsonSchema: {
      type: "object",
      properties: {
        result: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
        findings: { type: "array", items: { type: "object", properties: { check: { type: "string" }, severity: { type: "string", enum: ["PASS", "WARN", "FAIL"] }, message: { type: "string" } }, required: ["check", "severity", "message"] } },
      },
      required: ["result", "findings"],
    },
    schema: Review,
    maxTokens: 4000,
  });
  ctx.usage(r.usage, r.costEstimate, r.model);
  // The report binds to the revision the job was created for; a newer revision needs its own review.
  const result = r.value.findings.some((f) => f.severity === "FAIL") ? "FAIL" : r.value.result;
  const id = saveQaReport({ contentId: b.item.id, revisionId, kind: "AI_EDITORIAL", result, findings: r.value.findings, jobId: ctx.job.id, reviewer: `anthropic:${r.model}` });
  return { reportId: id, result, revision: rev.number, stale: revisionId !== getContent(b.item.id).current_revision_id };
}
