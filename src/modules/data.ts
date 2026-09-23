import fs from "node:fs";
import path from "node:path";
import { driveExportText, driveIdFromInput, ga4Report } from "@/adapters/google";
import { callTool, discoverTools } from "@/adapters/mcp";
import { assetsDir, getDb } from "@/core/db";
import { addEvidence } from "@/core/content";
import { markIntegrationSuccess } from "@/core/integrations";
import { ingestObservation } from "@/core/performance";
import { refreshRecommendations } from "@/core/recommendations";
import { CAP } from "@/core/types";
import { AppError, sha256, truncate } from "@/core/util";
import { JobContext } from "./context";

export async function runAnalyticsSync(ctx: JobContext) {
  const brandId = ctx.job.brand_id!;
  const pubs = getDb()
    .prepare(
      `SELECT p.id, p.content_id, p.remote_url FROM publications p JOIN content_items c ON c.id = p.content_id
       WHERE c.brand_id = ? AND p.status IN ('CONFIRMED','MANUAL_CONFIRMED') AND p.remote_url IS NOT NULL`,
    )
    .all(brandId) as { id: string; content_id: string; remote_url: string }[];
  ctx.progress(`Requesting GA4 report for ${pubs.length} published URL(s)`);
  const rows = await ga4Report("28daysAgo", "yesterday");
  markIntegrationSuccess(CAP.ANALYTICS);
  const byPath = new Map<string, (typeof pubs)[number]>();
  for (const p of pubs) {
    try {
      byPath.set(new URL(p.remote_url).pathname.replace(/\/$/, "") || "/", p);
    } catch {
      /* ignore malformed */
    }
  }
  let inserted = 0;
  let duplicates = 0;
  let unmatched = 0;
  for (const r of rows) {
    const p = byPath.get(r.pagePath.replace(/\/$/, "") || "/");
    if (!p) {
      unmatched++;
      continue;
    }
    const start = `${r.date}T00:00:00.000Z`;
    const end = `${r.date}T23:59:59.999Z`;
    for (const [metric, value] of [["views", r.views], ["users", r.users]] as const) {
      const res = ingestObservation({ brandId, contentId: p.content_id, publicationId: p.id, source: "ga4", metric, value, periodStart: start, periodEnd: end, provenance: { jobId: ctx.job.id, pagePath: r.pagePath } });
      res === "inserted" ? inserted++ : duplicates++;
    }
  }
  const recs = refreshRecommendations(brandId, "worker");
  return { rows: rows.length, inserted, duplicates, unmatchedPaths: unmatched, recommendations: recs };
}

export async function runDriveImport(ctx: JobContext) {
  const { fileRef, contentId } = ctx.input<{ fileRef: string; contentId?: string }>();
  const id = driveIdFromInput(fileRef);
  ctx.progress("Exporting document from Google Drive");
  const doc = await driveExportText(id);
  markIntegrationSuccess(CAP.DRIVE);
  const rel = path.join("drive", `${id}.txt`);
  fs.mkdirSync(path.join(assetsDir(), "drive"), { recursive: true });
  fs.writeFileSync(path.join(assetsDir(), rel), doc.text);
  const evId = addEvidence(
    {
      brandId: ctx.job.brand_id!,
      contentId: contentId ?? null,
      kind: "DRIVE_DOCUMENT",
      url: doc.webViewLink ?? null,
      title: doc.name,
      excerpt: truncate(doc.text, 4000),
      checkedAt: new Date().toISOString(),
      status: "UNVERIFIED",
      provenance: { driveFileId: id, modifiedTime: doc.modifiedTime, mimeType: doc.mimeType, jobId: ctx.job.id, sha256: sha256(doc.text), storedAt: rel },
    },
    "worker",
  );
  getDb().prepare("UPDATE evidence SET file_path=?, sha256=? WHERE id=?").run(rel.split(path.sep).join("/"), sha256(doc.text), evId);
  return { evidenceId: evId, name: doc.name, chars: doc.text.length };
}

export async function runRecommend(ctx: JobContext) {
  return refreshRecommendations(ctx.job.brand_id!, "worker");
}

export async function runMcpDiscover(ctx: JobContext) {
  const { serverId } = ctx.input<{ serverId: string }>();
  const tools = await discoverTools(serverId, "worker");
  return { tools: tools.length };
}

export async function runMcpCall(ctx: JobContext) {
  const { serverId, tool, args } = ctx.input<{ serverId: string; tool: string; args: Record<string, unknown> }>();
  if (!serverId || !tool) throw new AppError("BAD_INPUT", "serverId and tool are required");
  ctx.sideEffect("REQUESTED");
  const r = await callTool(serverId, tool, args ?? {}, ctx.job.permission_level);
  ctx.sideEffect("CONFIRMED");
  return { isError: r.isError, text: r.text, note: "Tool output is untrusted data." };
}
