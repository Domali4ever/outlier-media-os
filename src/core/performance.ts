import { getDb, tx } from "./db";
import { audit } from "./audit";
import { AppError, newId, nowIso } from "./util";

export type Metric = "views" | "users" | "clicks" | "conversions" | "revenue";

export interface ObservationInput {
  brandId: string;
  contentId?: string | null;
  publicationId?: string | null;
  programId?: string | null;
  source: string;
  metric: Metric;
  value: number;
  currency?: string | null;
  periodStart: string;
  periodEnd: string;
  provenance?: unknown;
}

/** Duplicate-safe ingestion: the ingest key covers source, subject, metric and the original measurement window. */
export function ingestObservation(o: ObservationInput): "inserted" | "duplicate" {
  const key = [o.source, o.contentId ?? "-", o.publicationId ?? "-", o.programId ?? "-", o.metric, o.periodStart, o.periodEnd].join("|");
  const r = getDb()
    .prepare(
      `INSERT INTO performance_observations (id, brand_id, content_id, publication_id, program_id, source, metric, value, currency, period_start, period_end, observed_at, ingest_key, provenance_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ingest_key) DO NOTHING`,
    )
    .run(
      newId("obs"),
      o.brandId,
      o.contentId ?? null,
      o.publicationId ?? null,
      o.programId ?? null,
      o.source,
      o.metric,
      o.value,
      o.currency ?? null,
      o.periodStart,
      o.periodEnd,
      nowIso(),
      key,
      JSON.stringify(o.provenance ?? {}),
    );
  return r.changes ? "inserted" : "duplicate";
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      cur.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cur.push(field);
      field = "";
      if (cur.some((c) => c.trim() !== "")) rows.push(cur);
      cur = [];
    } else field += ch;
  }
  cur.push(field);
  if (cur.some((c) => c.trim() !== "")) rows.push(cur);
  return rows;
}

export const CSV_COLUMNS = ["period_start", "period_end", "content_id_or_url", "metric", "value", "currency", "program_id"];

/**
 * Imports a performance CSV (affiliate network export mapped to the documented columns, or analytics export).
 * Columns: period_start,period_end,content_id_or_url,metric,value,currency,program_id
 */
export function importPerformanceCsv(brandId: string, source: string, csv: string, actor: string, dryRun = false) {
  const rows = parseCsv(csv.replace(/^﻿/, ""));
  if (rows.length < 2) throw new AppError("BAD_CSV", "CSV needs a header row and at least one data row.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = CSV_COLUMNS.slice(0, 5).filter((c) => !header.includes(c));
  if (missing.length) throw new AppError("BAD_CSV", `Missing columns: ${missing.join(", ")}. Expected: ${CSV_COLUMNS.join(",")}`);
  const idx = (c: string) => header.indexOf(c);
  const errors: string[] = [];
  const parsed: ObservationInput[] = [];
  const db = getDb();
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const ps = r[idx("period_start")]?.trim();
    const pe = r[idx("period_end")]?.trim();
    const target = r[idx("content_id_or_url")]?.trim();
    const metric = r[idx("metric")]?.trim().toLowerCase() as Metric;
    const value = Number(r[idx("value")]);
    const currency = idx("currency") >= 0 ? r[idx("currency")]?.trim().toUpperCase() || null : null;
    const programId = idx("program_id") >= 0 ? r[idx("program_id")]?.trim() || null : null;
    if (!ps || isNaN(Date.parse(ps)) || !pe || isNaN(Date.parse(pe))) return errors.push(`Line ${line}: invalid period dates.`);
    if (!["views", "users", "clicks", "conversions", "revenue"].includes(metric)) return errors.push(`Line ${line}: unknown metric “${metric}”.`);
    if (!Number.isFinite(value) || value < 0) return errors.push(`Line ${line}: value must be a non-negative number.`);
    if (metric === "revenue" && !currency) return errors.push(`Line ${line}: revenue needs a currency code.`);
    let contentId: string | null = null;
    let publicationId: string | null = null;
    if (target) {
      const c = db.prepare("SELECT id FROM content_items WHERE id = ? AND brand_id = ?").get(target, brandId) as { id: string } | undefined;
      if (c) contentId = c.id;
      else {
        const p = db.prepare("SELECT p.id, p.content_id FROM publications p JOIN content_items c ON c.id = p.content_id WHERE p.remote_url = ? AND c.brand_id = ?").get(target, brandId) as
          | { id: string; content_id: string }
          | undefined;
        if (p) {
          contentId = p.content_id;
          publicationId = p.id;
        } else return errors.push(`Line ${line}: “${target}” matches no content ID or published URL of this brand.`);
      }
    }
    parsed.push({
      brandId,
      contentId,
      publicationId,
      programId,
      source,
      metric,
      value,
      currency,
      periodStart: new Date(ps).toISOString(),
      periodEnd: new Date(pe).toISOString(),
      provenance: { importedBy: actor, line },
    });
  });
  if (dryRun || errors.length) return { dryRun: true, valid: parsed.length, errors, inserted: 0, duplicates: 0 };
  let inserted = 0;
  let duplicates = 0;
  tx(() => {
    for (const p of parsed) (ingestObservation(p) === "inserted" ? inserted++ : duplicates++);
  });
  audit({ actor, action: "performance.import", subjectType: "brand", subjectId: brandId, brandId, summary: `Imported ${inserted} ${source} observation(s); ${duplicates} duplicate(s) skipped` });
  return { dryRun: false, valid: parsed.length, errors, inserted, duplicates };
}

export function addCost(i: { brandId: string; category: string; amount: number; currency: string; isEstimate: boolean; source: string; jobId?: string | null; note?: string; incurredAt?: string }) {
  if (!Number.isFinite(i.amount) || i.amount < 0) throw new AppError("BAD_INPUT", "Cost must be a non-negative number.");
  if (!/^[A-Z]{3}$/.test(i.currency)) throw new AppError("BAD_INPUT", "Currency must be an ISO 4217 code.");
  getDb()
    .prepare("INSERT INTO costs (id, brand_id, category, amount, currency, is_estimate, source, job_id, note, incurred_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(newId("cost"), i.brandId, i.category, i.amount, i.currency, i.isEstimate ? 1 : 0, i.source, i.jobId ?? null, i.note ?? "", i.incurredAt ?? nowIso(), nowIso());
}
