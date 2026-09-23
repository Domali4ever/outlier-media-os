import { z } from "zod";
import { fenceUntrusted, structured } from "@/adapters/anthropic";
import { fetchPage, search } from "@/adapters/brave";
import { getDb, tx } from "@/core/db";
import { addClaim, addEvidence, getContent, saveRevision } from "@/core/content";
import { getBrand } from "@/core/brand";
import { CLAIM_TYPES } from "@/core/types";
import { AppError, nowIso, truncate } from "@/core/util";
import { JobContext, prompt } from "./context";

const QueryPlan = z.object({
  queries: z.array(z.string().min(3)).min(1).max(6),
  buyer_problem: z.string(),
  buyer_intent_guess: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

const Synthesis = z.object({
  summary: z.string(),
  key_points: z.array(z.object({ point: z.string(), source_urls: z.array(z.string()) })),
  claims: z.array(z.object({ text: z.string(), claim_type: z.enum(CLAIM_TYPES), source_url: z.string(), supported: z.boolean() })),
  conflicts_or_outdated: z.array(z.string()),
  offer_angles: z.array(z.string()),
});

export async function runResearch(ctx: JobContext) {
  const item = getContent(ctx.job.content_id!);
  const brand = getBrand(item.brand_id);
  getDb().prepare("UPDATE content_items SET research_status='IN_PROGRESS', stage=CASE WHEN stage='IDEA' THEN 'RESEARCH' ELSE stage END, updated_at=? WHERE id=?").run(nowIso(), item.id);

  ctx.progress("Planning search queries");
  const plan = await structured({
    system: prompt("research_queries"),
    user: `Topic: ${item.title}\nMarket: ${brand.market}\nLanguage: ${brand.language}`,
    toolName: "research_plan",
    toolDescription: "Return search queries and the buyer problem.",
    jsonSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
        buyer_problem: { type: "string" },
        buyer_intent_guess: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
      },
      required: ["queries", "buyer_problem", "buyer_intent_guess"],
    },
    schema: QueryPlan,
    maxTokens: 1000,
  });
  ctx.usage(plan.usage, plan.costEstimate, plan.model);

  const seen = new Set<string>();
  const results: { title: string; url: string; description: string }[] = [];
  for (const q of plan.value.queries) {
    ctx.progress(`Searching: ${q}`);
    for (const r of await search(q, 5, brand.market)) {
      const key = r.url.replace(/#.*$/, "");
      if (!seen.has(key)) {
        seen.add(key);
        results.push(r);
      }
    }
  }
  if (!results.length) throw new AppError("NO_SOURCES", "Search returned no results; nothing to research from.");

  const pages: { url: string; title: string; text: string; sha: string; at: string; evidenceId: string }[] = [];
  for (const r of results.slice(0, 8)) {
    ctx.progress(`Fetching ${new URL(r.url).hostname}`);
    try {
      const p = await fetchPage(r.url);
      if (p.text.length < 300) continue;
      const evidenceId = addEvidence(
        {
          brandId: item.brand_id,
          contentId: item.id,
          kind: "WEB_SOURCE",
          url: r.url,
          title: p.finalTitle || r.title,
          excerpt: truncate(p.text, 4000),
          checkedAt: p.fetchedAt,
          status: "UNVERIFIED",
          provenance: { jobId: ctx.job.id, query: "research", sha256: p.sha256, searchSnippet: r.description },
        },
        "worker",
      );
      getDb().prepare("UPDATE evidence SET sha256=? WHERE id=?").run(p.sha256, evidenceId);
      pages.push({ url: r.url, title: p.finalTitle || r.title, text: p.text, sha: p.sha256, at: p.fetchedAt, evidenceId });
    } catch {
      /* a single unreachable page is not fatal; it is simply not evidence */
    }
    if (pages.length >= 6) break;
  }
  if (!pages.length) throw new AppError("NO_SOURCES", "No source page could be fetched; research cannot proceed without evidence.");

  ctx.progress(`Synthesizing ${pages.length} sources`);
  const syn = await structured({
    system: prompt("research_synthesis"),
    user: `Topic: ${item.title}\nBuyer problem (guess): ${plan.value.buyer_problem}\n\n${pages.map((p) => fenceUntrusted(p.url, `Title: ${p.title}\nFetched: ${p.at}\n\n${truncate(p.text, 9000)}`)).join("\n\n")}`,
    toolName: "research_synthesis",
    toolDescription: "Return the sourced research synthesis.",
    jsonSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        key_points: { type: "array", items: { type: "object", properties: { point: { type: "string" }, source_urls: { type: "array", items: { type: "string" } } }, required: ["point", "source_urls"] } },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, claim_type: { type: "string", enum: [...CLAIM_TYPES] }, source_url: { type: "string" }, supported: { type: "boolean" } },
            required: ["text", "claim_type", "source_url", "supported"],
          },
        },
        conflicts_or_outdated: { type: "array", items: { type: "string" } },
        offer_angles: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "key_points", "claims", "conflicts_or_outdated", "offer_angles"],
    },
    schema: Synthesis,
    maxTokens: 6000,
  });
  ctx.usage(syn.usage, syn.costEstimate, syn.model);

  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const points = syn.value.key_points
    .map((k) => ({ ...k, source_urls: k.source_urls.filter((u) => byUrl.has(u)) }))
    .filter((k) => k.source_urls.length > 0);
  const notes = [
    `## Research — ${nowIso().slice(0, 10)} (job ${ctx.job.id})`,
    `**Buyer problem (model guess):** ${plan.value.buyer_problem}`,
    `**Summary:** ${syn.value.summary}`,
    `### Key points`,
    ...points.map((k) => `- ${k.point} — ${k.source_urls.map((u) => `[source](${u})`).join(", ")}`),
    syn.value.conflicts_or_outdated.length ? `### Conflicts / possibly outdated\n${syn.value.conflicts_or_outdated.map((c) => `- ${c}`).join("\n")}` : "",
    syn.value.offer_angles.length ? `### Offer angles (unvalidated)\n${syn.value.offer_angles.map((c) => `- ${c}`).join("\n")}` : "",
    `### Sources (fetched ${pages[0].at.slice(0, 10)})`,
    ...pages.map((p) => `- ${p.title} — ${p.url}`),
  ]
    .filter(Boolean)
    .join("\n\n");

  let claimsAdded = 0;
  tx(() => {
    saveRevision(item.id, { researchNotes: notes, changeNote: "Research generated" }, "worker", ctx.job.id);
    for (const c of syn.value.claims) {
      const page = byUrl.get(c.source_url);
      addClaim(item.id, { text: c.text, claimType: c.claim_type, note: page && c.supported ? `Model cited ${c.source_url}; confirm before marking VERIFIED.` : "No supporting page among fetched sources." }, "worker");
      if (page && c.supported) {
        const id = (getDb().prepare("SELECT id FROM claims WHERE content_id=? ORDER BY created_at DESC LIMIT 1").get(item.id) as { id: string }).id;
        getDb().prepare("UPDATE claims SET evidence_id=? WHERE id=?").run(page.evidenceId, id);
      }
      claimsAdded++;
    }
    getDb()
      .prepare("UPDATE content_items SET research_status='RESEARCHED', buyer_intent=COALESCE(buyer_intent, ?), updated_at=? WHERE id=?")
      .run(plan.value.buyer_intent_guess, nowIso(), item.id);
  });
  return { sources: pages.length, keyPoints: points.length, claims: claimsAdded, discardedUncitedPoints: syn.value.key_points.length - points.length };
}
