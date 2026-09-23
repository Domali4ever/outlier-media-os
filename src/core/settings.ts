import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { nowIso, parseJson } from "./util";

export function getSetting<T>(key: string, fallback: T): T {
  const r = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? parseJson<T>(r.value, fallback) : fallback;
}

export function setSetting(key: string, value: unknown) {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    )
    .run(key, JSON.stringify(value), nowIso());
}

/* ---------------- Secrets: environment references only ----------------
 * Secrets are never stored in the database. Integrations store the NAME of an
 * environment variable. Values are read from process.env or, if absent there,
 * from .env.local / .env in the project root (re-read when the file changes,
 * so no restart is needed after editing it). Values never leave the server.
 */
let fileCache: { mtimes: string; values: Record<string, string> } | null = null;

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function envFiles(): string[] {
  const root = process.env.OMOS_ROOT || /*turbopackIgnore: true*/ process.cwd();
  return [path.join(root, ".env"), path.join(root, ".env.local")];
}

function fileValues(): Record<string, string> {
  const files = envFiles().filter((f) => fs.existsSync(f));
  const mtimes = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join("|");
  if (fileCache && fileCache.mtimes === mtimes) return fileCache.values;
  const values: Record<string, string> = {};
  for (const f of files) Object.assign(values, parseEnvFile(fs.readFileSync(f, "utf8")));
  fileCache = { mtimes, values };
  return values;
}

export function getSecret(name: string): string | undefined {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return undefined;
  const v = process.env[name] ?? fileValues()[name];
  return v && v.length > 0 ? v : undefined;
}

export function secretPresence(names: string[]): { name: string; present: boolean }[] {
  return names.map((name) => ({ name, present: !!getSecret(name) }));
}

export function getConfigValue(name: string, fallback = ""): string {
  return getSecret(name) ?? fallback;
}

/* ---------------- Operational switches ---------------- */
export function isSystemPaused(): boolean {
  return getSetting<boolean>("system_paused", false);
}
export function pausedJobTypes(): string[] {
  return getSetting<string[]>("paused_job_types", []);
}
export function allowHumanEditorialReview(): boolean {
  return getSetting<boolean>("allow_human_editorial_review", true);
}
