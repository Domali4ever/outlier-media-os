/**
 * Test helpers. Every test file gets an ISOLATED temporary database and data directory.
 * Fake providers used here are test-only (via __setFetchForTests) and never feed operational data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDbAt } from "@/core/db";
import { seedIfEmpty } from "@/core/seed";
import { __setFetchForTests } from "@/adapters/http";

export function freshDb(seed = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omos-test-"));
  process.env.OMOS_ROOT = dir; // no project .env.local leaks into tests
  process.env.BACKUP_DIR = path.join(dir, "backups");
  process.env.EXPORT_DIR = path.join(dir, "exports");
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|BRAVE|WP_|GOOGLE_|GA4_)/.test(k)) delete process.env[k];
  closeDb();
  __setFetchForTests(null);
  const db = openDbAt(path.join(dir, "data", "outlier.db"));
  if (seed) seedIfEmpty();
  return { dir, db };
}

export const LONG_BODY = (extra = "") =>
  `This article was produced with AI assistance and reviewed against cited sources. It is not medical advice.\n\n## Packing basics\n\n${"Keep the machine, mask and tubing together in a padded case so nothing is crushed in transit. ".repeat(8)}\n\nCheck your manufacturer's guide for the exact items to carry. See [the guide](https://example.com/guide).\n\n${extra}`;

type Handler = (url: string, init: RequestInit) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | Promise<never>;

/** Installs an isolated fake HTTP provider that records calls. */
export function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  __setFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = await handler(url, init ?? {});
    const body = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? { "content-type": "application/json" } });
  }) as typeof fetch);
  return calls;
}

import { approveAvatar, setBrandStatus } from "@/core/brand";
import { addEvidence, approveContent, createContent, moveStage, recordHumanReview, runQaNow, saveRevision, updateContentMeta } from "@/core/content";

export const BRAND = "brand_cpap_travel";

/** Builds a real READY item through every gate (no shortcuts). */
export function readyItem(activate = true): string {
  if (activate) {
    approveAvatar("avatar_cpap_guide_001", "operator");
    setBrandStatus(BRAND, "ACTIVE", "operator");
  }
  const id = createContent(BRAND, { title: "How to pack a CPAP for flights", risk: "LOW" }, "operator");
  moveStage(id, "RESEARCH", "operator");
  addEvidence({ brandId: BRAND, contentId: id, kind: "WEB_SOURCE", url: "https://example.com/guide", title: "Guide", checkedAt: new Date().toISOString() }, "operator");
  moveStage(id, "SCRIPT", "operator");
  saveRevision(id, { body: LONG_BODY() }, "operator");
  runQaNow(id, "operator");
  recordHumanReview(id, "PASS", "Checked every statement against the cited guide.", "operator");
  moveStage(id, "APPROVAL", "operator");
  updateContentMeta(id, { commercialDecision: "NO_OFFER" }, "operator");
  approveContent(id, "operator");
  moveStage(id, "READY", "operator");
  return id;
}
