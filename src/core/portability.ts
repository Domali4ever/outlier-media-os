import fs from "node:fs";
import path from "node:path";
import { assetsDir, currentSchemaVersion, dataDir, dbPath, getDb, tx } from "./db";
import { audit } from "./audit";
import { SCHEMA_VERSION } from "./migrations";
import { setSetting } from "./settings";
import { AppError, nowIso } from "./util";

/**
 * Export/import contract (omos.export.v1):
 * { format, schema_version, exported_at, app, tables: { <table>: row[] } }
 * - Credentials are never exported. Integrations export only env-variable NAMES.
 * - Sessions and operator password hash are excluded.
 * - Assets are referenced by relative path (evidence.file_path) and copied by backup/export-dir.
 */
export const EXPORT_TABLES = [
  "brands",
  "pillars",
  "avatars",
  "content_items",
  "content_revisions",
  "evidence",
  "claims",
  "qa_reports",
  "approvals",
  "programs",
  "commercial_facts",
  "offers",
  "integrations",
  "mcp_servers",
  "jobs",
  "job_events",
  "audit_events",
  "publications",
  "performance_observations",
  "costs",
  "recommendations",
  "policies",
  "checkins",
] as const;

const EXCLUDED_SETTINGS = new Set(["operator_password_hash", "worker_heartbeat"]);

export interface ExportBundle {
  format: "omos.export.v1";
  schema_version: number;
  exported_at: string;
  app: "outlier-media-os";
  tables: Record<string, Record<string, unknown>[]>;
  settings: { key: string; value: string }[];
}

export function exportAll(): ExportBundle {
  const db = getDb();
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of EXPORT_TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
  const settings = (db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]).filter((s) => !EXCLUDED_SETTINGS.has(s.key));
  return { format: "omos.export.v1", schema_version: currentSchemaVersion(), exported_at: nowIso(), app: "outlier-media-os", tables, settings };
}

export interface ImportReport {
  dryRun: boolean;
  ok: boolean;
  errors: string[];
  counts: Record<string, { incoming: number; new: number; existing: number }>;
  legacyMarked: number;
}

function columns(table: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/**
 * Validated import. Existing IDs are kept (never overwritten); new rows are inserted in dependency order.
 * With `asLegacy`, imported approvals/QA/jobs/publications become UNVERIFIED history instead of live state.
 */
export function importBundle(bundle: unknown, opts: { dryRun: boolean; asLegacy?: boolean; actor: string }): ImportReport {
  const errors: string[] = [];
  const b = bundle as Partial<ExportBundle>;
  if (!b || typeof b !== "object") throw new AppError("BAD_IMPORT", "Not a JSON object.");
  if (b.format !== "omos.export.v1") errors.push(`Unsupported format ${String(b.format)}; expected omos.export.v1.`);
  if (typeof b.schema_version !== "number") errors.push("Missing schema_version.");
  else if (b.schema_version > SCHEMA_VERSION) errors.push(`Bundle schema v${b.schema_version} is newer than this app (v${SCHEMA_VERSION}). Upgrade the app first.`);
  if (!b.tables || typeof b.tables !== "object") errors.push("Missing tables.");
  const counts: ImportReport["counts"] = {};
  if (errors.length) return { dryRun: opts.dryRun, ok: false, errors, counts, legacyMarked: 0 };
  const db = getDb();
  for (const t of EXPORT_TABLES) {
    const rows = (b.tables![t] ?? []) as Record<string, unknown>[];
    if (!Array.isArray(rows)) {
      errors.push(`${t} is not an array.`);
      continue;
    }
    const cols = columns(t);
    const pk = t === "job_events" || t === "audit_events" || t === "checkins" ? "id" : "id";
    let existing = 0;
    for (const r of rows) {
      const unknownCols = Object.keys(r).filter((k) => !cols.includes(k));
      if (unknownCols.length) {
        errors.push(`${t}: unknown column(s) ${unknownCols.join(", ")}.`);
        break;
      }
      if (r[pk] !== undefined && db.prepare(`SELECT 1 FROM ${t} WHERE ${pk} = ?`).get(r[pk] as string)) existing++;
    }
    counts[t] = { incoming: rows.length, new: rows.length - existing, existing };
  }
  if (errors.length || opts.dryRun) return { dryRun: opts.dryRun, ok: errors.length === 0, errors, counts, legacyMarked: 0 };
  let legacyMarked = 0;
  tx(() => {
    db.pragma("defer_foreign_keys = ON");
    for (const t of EXPORT_TABLES) {
      const rows = (b.tables![t] ?? []) as Record<string, unknown>[];
      for (const raw of rows) {
        const r = { ...raw };
        if (t === "integrations") continue; // integration definitions come from code; states must be re-tested here
        if (opts.asLegacy) {
          if (t === "approvals") {
            r.status = "INVALIDATED";
            r.legacy = 1;
            r.invalidated_reason = "Imported legacy approval — unverified history, not honored";
            r.invalidated_at = nowIso();
            legacyMarked++;
          }
          if (t === "jobs" && ["QUEUED", "BLOCKED", "RUNNING", "RETRYING"].includes(String(r.state))) {
            r.state = "CANCELLED";
            r.legacy = 1;
            legacyMarked++;
          }
          if (t === "jobs" && r.state === "COMPLETE") {
            r.state = "NEEDS_ATTENTION";
            r.legacy = 1;
            r.error_json = JSON.stringify({ code: "LEGACY_UNVERIFIED", message: "Imported as unverified history; result not counted as complete." });
            legacyMarked++;
          }
          if (t === "content_items") {
            r.legacy = 1;
            r.verification_status = "UNVERIFIED";
            if (["APPROVAL", "READY", "PUBLISHED", "MEASURE"].includes(String(r.stage))) r.stage = "SCRIPT";
          }
          if (t === "programs") {
            r.legacy = 1;
            if (r.program_status === "QUALIFIED") r.program_status = "DISCOVERED";
          }
          if (t === "commercial_facts" && r.status === "VERIFIED") r.status = "UNVERIFIED";
          if (t === "offers") r.link_status = "INACTIVE";
          if (t === "qa_reports") continue;
          if (t === "publications") continue;
        }
        const keys = Object.keys(r);
        db.prepare(`INSERT OR IGNORE INTO ${t} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => r[k] as never));
      }
    }
  });
  audit({ actor: opts.actor, action: "data.import", subjectType: "system", subjectId: "import", summary: `Imported bundle (${Object.values(counts).reduce((a, c) => a + c.new, 0)} new rows${opts.asLegacy ? `, ${legacyMarked} marked as unverified legacy history` : ""})` });
  return { dryRun: false, ok: true, errors, counts, legacyMarked };
}

function copyDir(src: string, dst: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export function backupsDir(): string {
  return path.resolve(process.env.BACKUP_DIR || path.join(dataDir(), "..", "backups"));
}

/** Full backup: consistent SQLite snapshot (online backup API) + assets + manifest. */
export async function backupNow(actor: string): Promise<{ dir: string }> {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const dir = path.join(backupsDir(), `backup-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  await getDb().backup(path.join(dir, "outlier.db"));
  copyDir(assetsDir(), path.join(dir, "assets"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ format: "omos.backup.v1", created_at: nowIso(), schema_version: currentSchemaVersion(), db: "outlier.db", assets: "assets/", source_db: dbPath() }, null, 2),
  );
  setSetting("last_backup_at", nowIso());
  audit({ actor, action: "data.backup", subjectType: "system", subjectId: "backup", summary: `Backup written to ${dir}` });
  return { dir };
}

/** Writes an export directory: data.json (+ assets copy). */
export function exportToDir(actor: string): { dir: string } {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const dir = path.resolve(process.env.EXPORT_DIR || path.join(dataDir(), "..", "exports"), `export-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(exportAll(), null, 2));
  copyDir(assetsDir(), path.join(dir, "assets"));
  audit({ actor, action: "data.export", subjectType: "system", subjectId: "export", summary: `Export written to ${dir}` });
  return { dir };
}

/**
 * Restore (run with the app and worker STOPPED — see README). Takes a safety backup of the
 * current database first, then replaces the database and assets with the backup's copies.
 */
export function restoreFrom(backupDir: string): { safetyCopy: string } {
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
  if (manifest.format !== "omos.backup.v1") throw new AppError("BAD_BACKUP", "Not an omos.backup.v1 directory.");
  const target = dbPath();
  const safety = `${target}.pre-restore-${Date.now()}`;
  if (fs.existsSync(target)) fs.copyFileSync(target, safety);
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(target + suffix)) fs.rmSync(target + suffix);
  fs.copyFileSync(path.join(backupDir, manifest.db), target);
  const assetsSafety = `${assetsDir()}.pre-restore-${Date.now()}`;
  if (fs.existsSync(assetsDir())) fs.renameSync(assetsDir(), assetsSafety);
  copyDir(path.join(backupDir, "assets"), assetsDir());
  return { safetyCopy: safety };
}
