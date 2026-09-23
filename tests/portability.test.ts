import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cloneBrand, getAvatars, getBrand } from "@/core/brand";
import { addEvidence, listContent, listPublications, recordManualPublication } from "@/core/content";
import { addProgram, setFact } from "@/core/commercial";
import { assetsDir, closeDb, getDb, openDbAt } from "@/core/db";
import { setupOperator } from "@/core/auth";
import { importPerformanceCsv } from "@/core/performance";
import { backupNow, exportAll, importBundle, restoreFrom } from "@/core/portability";
import { refreshRecommendations } from "@/core/recommendations";
import { BRAND, freshDb, readyItem } from "./helpers";

describe("cloning", () => {
  it("remaps IDs, keeps provenance, excludes approvals/publications/performance/jobs, starts DRAFT", () => {
    freshDb();
    const id = readyItem();
    recordManualPublication(id, { url: "https://blog.example/p", proofNote: "Checked live in a browser." }, "operator");
    const p = addProgram(BRAND, { name: "Prog" }, "operator");
    setFact(p, "commission", { value: "5%", sourceUrl: "https://p.example", checkedAt: "2026-09-01", evidence: "Five percent per the page.", status: "VERIFIED" }, "operator");
    const { brandId, idMap } = cloneBrand(BRAND, { name: "CPAP Travel UK", market: "GB", language: "en", currency: "GBP" }, "operator");
    const b = getBrand(brandId);
    expect(b.status).toBe("DRAFT");
    expect(b.origin_id).toBe(BRAND);
    expect(getAvatars(brandId)[0].lifecycle_status).toBe("DRAFT");
    const items = listContent(brandId);
    expect(items.length).toBe(8); // IDEA templates only — the published item is excluded
    expect(items.every((i) => i.stage === "IDEA" && i.id !== idMap[i.id])).toBe(true);
    expect(items.every((i) => !listContent(BRAND).some((o) => o.id === i.id))).toBe(true);
    const db = getDb();
    const n = (sql: string) => (db.prepare(sql).get(brandId) as { n: number }).n;
    expect(n("SELECT COUNT(*) n FROM approvals a JOIN content_items c ON c.id=a.subject_id WHERE c.brand_id=?")).toBe(0);
    expect(n("SELECT COUNT(*) n FROM jobs WHERE brand_id=?")).toBe(0);
    expect(n("SELECT COUNT(*) n FROM performance_observations WHERE brand_id=?")).toBe(0);
    const fact = db.prepare("SELECT f.* FROM commercial_facts f JOIN programs p ON p.id=f.program_id WHERE p.brand_id=? AND f.criterion='commission'").get(brandId) as { status: string; source_url: string; provenance_json: string };
    expect(fact.status).toBe("UNVERIFIED");
    expect(fact.source_url).toBe("https://p.example");
    expect(JSON.parse(fact.provenance_json).revalidation).toBe("REQUIRED");
  });
});

describe("export / import / backup / restore", () => {
  it("export excludes the password hash and has no secret values", () => {
    freshDb();
    setupOperator("a-very-long-password");
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-export-123";
    const s = JSON.stringify(exportAll());
    expect(s).not.toContain("operator_password_hash");
    expect(s).not.toContain("sk-ant-should-never-export");
    expect(s).toContain("ANTHROPIC_API_KEY"); // only the reference name
  });

  it("dry run validates without writing; apply round-trips into a fresh database", () => {
    const a = freshDb();
    readyItem();
    const bundle = exportAll();
    freshDb(false);
    const dry = importBundle(bundle, { dryRun: true, actor: "test" });
    expect(dry.ok).toBe(true);
    expect((getDb().prepare("SELECT COUNT(*) n FROM content_items").get() as { n: number }).n).toBe(0);
    const r = importBundle(bundle, { dryRun: false, actor: "test" });
    expect(r.ok).toBe(true);
    expect(listContent(BRAND).length).toBe(9);
    expect(importBundle({ format: "other" }, { dryRun: true, actor: "t" }).ok).toBe(false);
    void a;
  });

  it("legacy import keeps history but never honors unverified approvals or completions", () => {
    freshDb();
    const id = readyItem();
    getDb().prepare(`INSERT INTO jobs (id,type,brand_id,input_json,state,actor,permission_level,idempotency_key,run_after,correlation_id,created_at,updated_at)
      VALUES ('job_commercial_qualification_001','FIND_OFFERS',?,'{}','COMPLETE','import',1,'legacy-1','2026-01-01','c','2026-01-01','2026-01-01')`).run(BRAND);
    const bundle = exportAll();
    freshDb(false);
    importBundle(bundle, { dryRun: false, asLegacy: true, actor: "test" });
    const c = getDb().prepare("SELECT stage, legacy, verification_status FROM content_items WHERE id=?").get(id) as { stage: string; legacy: number; verification_status: string };
    expect(c).toEqual({ stage: "SCRIPT", legacy: 1, verification_status: "UNVERIFIED" });
    expect((getDb().prepare("SELECT COUNT(*) n FROM approvals WHERE status='ACTIVE'").get() as { n: number }).n).toBe(0);
    expect((getDb().prepare("SELECT state FROM jobs WHERE id='job_commercial_qualification_001'").get() as { state: string }).state).toBe("NEEDS_ATTENTION");
    refreshRecommendations(BRAND);
    expect((getDb().prepare("SELECT COUNT(*) n FROM recommendations WHERE type='INVESTIGATE'").get() as { n: number }).n).toBeGreaterThan(0);
  });

  it("backup and restore preserve records and assets", async () => {
    const { dir } = freshDb();
    const id = readyItem();
    addEvidence({ brandId: BRAND, contentId: id, kind: "DOCUMENT", title: "Scan", file: { name: "scan.txt", data: Buffer.from("hello") } }, "operator");
    const { dir: bdir } = await backupNow("test");
    getDb().prepare("DELETE FROM claims").run();
    getDb().prepare("UPDATE content_items SET title='changed' WHERE id=?").run(id);
    fs.rmSync(assetsDir(), { recursive: true });
    closeDb();
    restoreFrom(bdir);
    openDbAt(path.join(dir, "data", "outlier.db"));
    expect(listContent(BRAND).find((c) => c.id === id)!.title).toBe("How to pack a CPAP for flights");
    const ev = getDb().prepare("SELECT file_path FROM evidence WHERE title='Scan'").get() as { file_path: string };
    expect(fs.readFileSync(path.join(assetsDir(), ev.file_path), "utf8")).toBe("hello");
  });
});

describe("performance CSV import", () => {
  it("validates, dry-runs, dedupes by measurement window and maps URLs to publications", () => {
    freshDb();
    const id = readyItem();
    recordManualPublication(id, { url: "https://blog.example/p", proofNote: "Checked live in a browser." }, "operator");
    const csv = "period_start,period_end,content_id_or_url,metric,value,currency,program_id\n2026-09-01,2026-09-07,https://blog.example/p,clicks,4,,\n2026-09-01,2026-09-07," + id + ",revenue,12.5,CAD,\n";
    expect(importPerformanceCsv(BRAND, "affiliate_csv", csv, "operator", true).valid).toBe(2);
    expect((getDb().prepare("SELECT COUNT(*) n FROM performance_observations").get() as { n: number }).n).toBe(0);
    expect(importPerformanceCsv(BRAND, "affiliate_csv", csv, "operator").inserted).toBe(2);
    expect(importPerformanceCsv(BRAND, "affiliate_csv", csv, "operator").duplicates).toBe(2);
    const bad = importPerformanceCsv(BRAND, "affiliate_csv", "period_start,period_end,content_id_or_url,metric,value\n2026-09-01,2026-09-07,nowhere,revenue,5\n", "operator");
    expect(bad.errors.length).toBe(1);
    expect(listPublications(id)).toHaveLength(1);
  });
});
