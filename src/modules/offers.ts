import { z } from "zod";
import { fenceUntrusted, structured } from "@/adapters/anthropic";
import { fetchPage, search } from "@/adapters/brave";
import { getDb } from "@/core/db";
import { getBrand } from "@/core/brand";
import { addProgram, listPrograms } from "@/core/commercial";
import { COMMERCIAL_CRITERIA } from "@/core/types";
import { AppError, nowIso, truncate } from "@/core/util";
import { JobContext, prompt } from "./context";

const Found = z.object({
  programs: z.array(
    z.object({
      name: z.string(),
      network: z.string(),
      url: z.string(),
      facts: z.array(z.object({ criterion: z.enum(COMMERCIAL_CRITERIA), value: z.string(), source_url: z.string(), quote: z.string() })),
    }),
  ),
});

/** FIND OFFERS: discovers programs with page evidence. Never qualifies, applies or activates anything. */
export async function runFindOffers(ctx: JobContext) {
  const brand = getBrand(ctx.job.brand_id!);
  const { focus } = ctx.input<{ focus?: string }>();
  const queries = [
    `${focus ?? "CPAP accessories"} affiliate program`,
    `CPAP supplies affiliate program commission ${brand.market}`,
    `travel CPAP case affiliate program`,
  ];
  const seen = new Set<string>();
  const pages: { url: string; text: string; at: string }[] = [];
  for (const q of queries) {
    ctx.progress(`Searching: ${q}`);
    for (const r of await search(q, 5, brand.market)) {
      if (seen.has(r.url) || pages.length >= 8) continue;
      seen.add(r.url);
      try {
        ctx.progress(`Fetching ${new URL(r.url).hostname}`);
        const p = await fetchPage(r.url);
        if (p.text.length > 300) pages.push({ url: r.url, text: p.text, at: p.fetchedAt });
      } catch {
        /* skip unreachable page */
      }
    }
  }
  if (!pages.length) throw new AppError("NO_SOURCES", "No program pages could be fetched.");
  ctx.progress(`Extracting programs from ${pages.length} pages`);
  const r = await structured({
    system: prompt("find_offers"),
    user: `Brand market: ${brand.market}. Language: ${brand.language}.\n\n${pages.map((p) => fenceUntrusted(p.url, truncate(p.text, 8000))).join("\n\n")}`,
    toolName: "programs_found",
    toolDescription: "Return affiliate programs with page-evidenced facts.",
    jsonSchema: {
      type: "object",
      properties: {
        programs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              network: { type: "string" },
              url: { type: "string" },
              facts: {
                type: "array",
                items: { type: "object", properties: { criterion: { type: "string", enum: [...COMMERCIAL_CRITERIA] }, value: { type: "string" }, source_url: { type: "string" }, quote: { type: "string" } }, required: ["criterion", "value", "source_url", "quote"] },
              },
            },
            required: ["name", "network", "url", "facts"],
          },
        },
      },
      required: ["programs"],
    },
    schema: Found,
    maxTokens: 6000,
  });
  ctx.usage(r.usage, r.costEstimate, r.model);
  const fetched = new Map(pages.map((p) => [p.url, p]));
  const existing = listPrograms(brand.id).map((p) => p.name.toLowerCase());
  const created: string[] = [];
  for (const p of r.value.programs) {
    if (existing.includes(p.name.toLowerCase())) continue;
    let url = "";
    try {
      url = new URL(p.url).toString();
    } catch {
      url = "";
    }
    const id = addProgram(brand.id, { name: p.name, network: p.network, url, notes: `Discovered by job ${ctx.job.id}. Unverified.` }, "worker");
    for (const f of p.facts) {
      const page = fetched.get(f.source_url);
      if (!page || !f.value.trim()) continue; // only facts with a real fetched source are recorded
      getDb()
        .prepare("UPDATE commercial_facts SET value=?, source_url=?, checked_at=?, evidence=?, status='UNVERIFIED', provenance_json=?, updated_at=? WHERE program_id=? AND criterion=?")
        .run(f.value, f.source_url, page.at, truncate(f.quote, 1000), JSON.stringify({ jobId: ctx.job.id, extractedBy: r.model }), nowIso(), id, f.criterion);
    }
    created.push(id);
  }
  return { pagesFetched: pages.length, programsDiscovered: created.length, programIds: created };
}
