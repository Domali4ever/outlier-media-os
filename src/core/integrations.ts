import { getDb } from "./db";
import { audit } from "./audit";
import { getSecret, secretPresence } from "./settings";
import { CAP, type IntegrationState } from "./types";
import { AppError, nowIso, parseJson, redact } from "./util";

export interface IntegrationDef {
  id: string;
  section: "AI" | "DATA" | "CONTENT" | "AFFILIATES" | "MEDIA" | "AUTOMATIONS";
  capability: string;
  provider: string;
  authMethod: string;
  scopes: string;
  secrets: string[];
  config: string[];
  limits: string;
  initial: IntegrationState;
  /** true when the capability needs an outside account; false for built-in local routes. */
  external: boolean;
  acceptance: string;
}

/** The bounded initial integration matrix. One provider per required capability. */
export const INTEGRATION_DEFS: IntegrationDef[] = [
  {
    id: CAP.AI,
    section: "AI",
    capability: "Structured generation + tool use",
    provider: "Anthropic Messages API",
    authMethod: "API key (x-api-key header)",
    scopes: "n/a — key scoped to your Anthropic workspace",
    secrets: ["ANTHROPIC_API_KEY"],
    config: ["ANTHROPIC_MODEL"],
    limits: "Workspace rate limits; local monthly spend cap enforced before every call",
    initial: "NOT_CONNECTED",
    external: true,
    acceptance: "GET /v1/models succeeds and lists the configured ANTHROPIC_MODEL",
  },
  {
    id: CAP.RESEARCH,
    section: "DATA",
    capability: "Web retrieval with source evidence",
    provider: "Brave Search API + direct page fetch",
    authMethod: "API key (X-Subscription-Token header)",
    scopes: "Web Search endpoint",
    secrets: ["BRAVE_SEARCH_API_KEY"],
    config: [],
    limits: "Plan query quota; pages fetched with 15 s timeout and 1.5 MB cap",
    initial: "NOT_CONNECTED",
    external: true,
    acceptance: "GET /res/v1/web/search?q=test&count=1 returns web results",
  },
  {
    id: CAP.DRIVE,
    section: "DATA",
    capability: "Google Drive document import (optional)",
    provider: "Google Drive API v3",
    authMethod: "OAuth 2.0 refresh token (your own Google Cloud client)",
    scopes: "https://www.googleapis.com/auth/drive.readonly",
    secrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
    config: [],
    limits: "Google API quota; read-only",
    initial: "NOT_CONNECTED",
    external: true,
    acceptance: "Token refresh succeeds and GET /drive/v3/about?fields=user returns the account",
  },
  {
    id: CAP.PUBLISH,
    section: "CONTENT",
    capability: "Publish articles",
    provider: "WordPress REST API (wp/v2)",
    authMethod: "Application password over HTTPS (Basic auth)",
    scopes: "WordPress user with the publish_posts capability",
    secrets: ["WP_APP_PASSWORD"],
    config: ["WP_BASE_URL", "WP_USERNAME"],
    limits: "Host-dependent; no automatic retry after a possibly-accepted publish",
    initial: "NOT_CONNECTED",
    external: true,
    acceptance: "GET /wp-json/wp/v2/users/me?context=edit authenticates and reports publish_posts",
  },
  {
    id: CAP.ANALYTICS,
    section: "CONTENT",
    capability: "Performance ingestion",
    provider: "Google Analytics 4 Data API (CSV import as fallback)",
    authMethod: "OAuth 2.0 refresh token (shared Google client)",
    scopes: "https://www.googleapis.com/auth/analytics.readonly",
    secrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
    config: ["GA4_PROPERTY_ID"],
    limits: "GA4 Data API core quota tokens per property",
    initial: "NOT_CONNECTED",
    external: true,
    acceptance: "properties/{GA4_PROPERTY_ID}:runReport returns a response for the last 7 days",
  },
  {
    id: CAP.AFFILIATE_REPORTING,
    section: "AFFILIATES",
    capability: "Affiliate reporting import",
    provider: "CSV import (built in) — no network API in the initial matrix",
    authMethod: "None — operator uploads network exports",
    scopes: "n/a",
    secrets: [],
    config: [],
    limits: "Duplicate rows are rejected by ingest key",
    initial: "LOCAL",
    external: false,
    acceptance: "CSV import validates, dedupes and stores observations (local test)",
  },
  {
    id: CAP.COMMERCE,
    section: "AFFILIATES",
    capability: "Commerce checkout and revenue events",
    provider: "Whop API + webhooks",
    authMethod: "Company API key",
    scopes: "Checkout creation, payment read, member read and webhook receive",
    secrets: ["WHOP_COMPANY_API_KEY"],
    config: ["WHOP_COMPANY_ID"],
    limits: "Sandbox and production use separate accounts and API hosts",
    initial: "NOT_CONNECTED",
    external: true,
    acceptance: "Retrieve the configured Whop company succeeds; checkout and webhooks are verified separately",
  },
  {
    id: CAP.MEDIA,
    section: "MEDIA",
    capability: "Voice / video generation",
    provider: "None — the chosen format (WordPress articles) does not need it",
    authMethod: "n/a",
    scopes: "n/a",
    secrets: [],
    config: [],
    limits: "",
    initial: "OUT_OF_SCOPE",
    external: false,
    acceptance: "Out of scope for the initial format",
  },
];

export interface IntegrationRow {
  id: string;
  section: string;
  capability: string;
  provider: string;
  auth_method: string;
  scopes: string;
  state: IntegrationState;
  config_json: string;
  secret_refs_json: string;
  last_test_at: string | null;
  last_test_result: string | null;
  last_success_at: string | null;
  last_error_json: string | null;
  limits_text: string;
  verified_capabilities_json: string;
  updated_at: string;
}

export function ensureIntegrations() {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO integrations (id, section, capability, provider, auth_method, scopes, state, secret_refs_json, limits_text, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET section=excluded.section, capability=excluded.capability, provider=excluded.provider,
       auth_method=excluded.auth_method, scopes=excluded.scopes, secret_refs_json=excluded.secret_refs_json, limits_text=excluded.limits_text`,
  );
  for (const d of INTEGRATION_DEFS) {
    ins.run(d.id, d.section, d.capability, d.provider, d.authMethod, d.scopes, d.initial, JSON.stringify(d.secrets.concat(d.config)), d.limits, nowIso());
  }
}

export function defFor(id: string): IntegrationDef {
  const d = INTEGRATION_DEFS.find((x) => x.id === id);
  if (!d) throw new AppError("NOT_FOUND", `Unknown integration ${id}`, 404);
  return d;
}

export function getIntegration(id: string): IntegrationRow {
  const r = getDb().prepare("SELECT * FROM integrations WHERE id = ?").get(id) as IntegrationRow | undefined;
  if (!r) throw new AppError("NOT_FOUND", `Unknown integration ${id}`, 404);
  return r;
}

export function listIntegrations(): (IntegrationRow & { def: IntegrationDef; missing: string[] })[] {
  const rows = getDb().prepare("SELECT * FROM integrations").all() as IntegrationRow[];
  return INTEGRATION_DEFS.map((def) => {
    const row = rows.find((r) => r.id === def.id)!;
    const missing = secretPresence(def.secrets.concat(def.config.filter((c) => c !== "ANTHROPIC_MODEL")))
      .filter((s) => !s.present)
      .map((s) => s.name);
    return { ...row, def, missing };
  }).filter((r) => r.id);
}

/** A capability is usable only after a real, passing validation (or it is a built-in local route). */
export function isCapabilityReady(id: string): boolean {
  const r = getDb().prepare("SELECT state FROM integrations WHERE id = ?").get(id) as { state: string } | undefined;
  if (!r) return false;
  return r.state === "CONNECTED" || r.state === "LOCAL";
}

export function capabilityBlockReason(id: string): string | null {
  const r = getDb().prepare("SELECT state, provider FROM integrations WHERE id = ?").get(id) as
    | { state: string; provider: string }
    | undefined;
  if (!r) return `${id} is not defined.`;
  if (r.state === "CONNECTED" || r.state === "LOCAL") return null;
  if (r.state === "OUT_OF_SCOPE") return `${id} is out of scope for this format.`;
  return `${id} (${r.provider}) is ${r.state}.`;
}

export function setIntegrationState(
  id: string,
  state: IntegrationState,
  patch: Partial<Pick<IntegrationRow, "last_test_at" | "last_test_result" | "last_success_at" | "last_error_json" | "verified_capabilities_json">> = {},
) {
  const cur = getIntegration(id);
  const merged = { ...cur, ...patch, state };
  getDb()
    .prepare(
      `UPDATE integrations SET state=?, last_test_at=?, last_test_result=?, last_success_at=?, last_error_json=?, verified_capabilities_json=?, updated_at=? WHERE id=?`,
    )
    .run(
      merged.state,
      merged.last_test_at,
      merged.last_test_result,
      merged.last_success_at,
      merged.last_error_json,
      merged.verified_capabilities_json,
      nowIso(),
      id,
    );
}

export function markIntegrationSuccess(id: string) {
  getDb().prepare("UPDATE integrations SET last_success_at=?, updated_at=? WHERE id=?").run(nowIso(), nowIso(), id);
}

/** Called when a live call fails in a way that indicates the connection is broken (auth, permission). */
export function markIntegrationDegraded(id: string, error: { code: string; message: string }) {
  const cur = getIntegration(id);
  if (cur.state === "PAUSED" || cur.state === "DISABLED") return;
  setIntegrationState(id, "DEGRADED", { last_error_json: redact(JSON.stringify({ ...error, at: nowIso() })) });
  audit({
    actor: "system",
    action: "integration.degraded",
    subjectType: "integration",
    subjectId: id,
    summary: `${id} degraded: ${error.message}`,
    level: "WARN",
  });
}

/** CONNECT: checks that the referenced environment values exist, then moves to CONFIGURING (a TEST must follow). */
export function connectIntegration(id: string, actor: string): { state: IntegrationState; missing: string[] } {
  const def = defFor(id);
  if (!def.external) throw new AppError("NOT_APPLICABLE", `${id} does not use an external connection.`);
  const names = def.secrets.concat(def.config.filter((c) => c !== "ANTHROPIC_MODEL"));
  const missing = secretPresence(names)
    .filter((s) => !s.present)
    .map((s) => s.name);
  if (missing.length) {
    setIntegrationState(id, "NOT_CONNECTED", {
      last_error_json: JSON.stringify({ code: "MISSING_CONFIG", message: `Set ${missing.join(", ")} in .env.local`, at: nowIso() }),
    });
    audit({ actor, action: "integration.connect", subjectType: "integration", subjectId: id, summary: `Connect ${id}: missing ${missing.join(", ")}`, level: "WARN" });
    return { state: "NOT_CONNECTED", missing };
  }
  const cur = getIntegration(id);
  const next: IntegrationState = cur.state === "CONNECTED" ? "CONNECTED" : "CONFIGURING";
  setIntegrationState(id, next);
  audit({ actor, action: "integration.connect", subjectType: "integration", subjectId: id, summary: `Connect ${id}: configuration found, test required` });
  return { state: next, missing: [] };
}

export function pauseIntegration(id: string, actor: string) {
  defFor(id);
  setIntegrationState(id, "PAUSED");
  audit({ actor, action: "integration.pause", subjectType: "integration", subjectId: id, summary: `${id} paused` });
}

export function disableIntegration(id: string, actor: string) {
  defFor(id);
  setIntegrationState(id, "DISABLED", { verified_capabilities_json: "[]" });
  audit({ actor, action: "integration.disable", subjectType: "integration", subjectId: id, summary: `${id} disabled` });
}

/** Resume from PAUSED/DISABLED — returns to CONFIGURING so a fresh test is required. */
export function resumeIntegration(id: string, actor: string) {
  defFor(id);
  setIntegrationState(id, "CONFIGURING");
  audit({ actor, action: "integration.resume", subjectType: "integration", subjectId: id, summary: `${id} resumed — test required` });
}

export function lastError(id: string): { code: string; message: string; at?: string } | null {
  return parseJson(getIntegration(id).last_error_json, null);
}

export function anthropicModel(): string {
  return getSecret("ANTHROPIC_MODEL") || "claude-sonnet-4-5";
}
