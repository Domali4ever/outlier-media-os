import { getDb } from "./db";

export type ImplState = "NOT_IMPLEMENTED" | "IN_PROGRESS" | "IMPLEMENTED" | "VERIFIED";
export type VerifyState = "LOCAL_VERIFIED" | "CONTRACT_TESTED" | "LIVE_VERIFIED" | "NOT_VERIFIED";

export interface ImplEntry {
  key: string;
  area: string;
  capability: string;
  impl: ImplState;
  /** Verification achieved in this repository's test suite (see docs/ACCEPTANCE.md). */
  verified: VerifyState;
  evidence: string;
  /** Integration id whose last successful live use upgrades verification to LIVE_VERIFIED. */
  liveVia?: string;
  dependency: string;
  next: string;
  done: string;
}

/**
 * Implementation register shown under SYSTEM DETAILS. Static entries describe what the delivered code
 * does and how it was verified; LIVE_VERIFIED is only ever computed from a recorded successful live call.
 */
export const IMPLEMENTATION: ImplEntry[] = [
  { key: "db", area: "DATA", capability: "SQLite store, migrations, transactional writes", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/persistence.test.ts", dependency: "—", next: "—", done: "Data survives app/worker restart" },
  { key: "workflow", area: "CONTENT", capability: "Stage transitions + server-side gates", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/workflow.test.ts", dependency: "—", next: "—", done: "Illegal moves refused via any entry point" },
  { key: "approvals", area: "CONTENT", capability: "Revision/destination/offer-bound approvals + invalidation", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/workflow.test.ts", dependency: "—", next: "—", done: "Edits invalidate affected approvals" },
  { key: "qa", area: "CONTENT", capability: "Deterministic QA (structural)", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/workflow.test.ts", dependency: "—", next: "—", done: "Does not imply factual/medical review" },
  { key: "jobs", area: "JOBS", capability: "Durable queue, leases, recovery, idempotency, backoff", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/jobs.test.ts", dependency: "Worker process running", next: "—", done: "Crash recovery + duplicate protection" },
  { key: "commands", area: "SYSTEM", capability: "Command dispatcher (structured) + AI interpretation", impl: "IMPLEMENTED", verified: "LOCAL_VERIFIED", evidence: "tests/commands.test.ts (structured only)", liveVia: "ai.structured_generation", dependency: "AI provider for natural language", next: "Live-verify NL path", done: "NL maps to one validated command" },
  { key: "ai", area: "AI", capability: "Anthropic structured generation (forced tool call + zod)", impl: "IMPLEMENTED", verified: "CONTRACT_TESTED", evidence: "tests/adapters.test.ts (isolated fake HTTP)", liveVia: "ai.structured_generation", dependency: "ANTHROPIC_API_KEY, prices, spend cap", next: "CONNECT + TEST in SYSTEM", done: "Test passes; first research job completes" },
  { key: "research", area: "DATA", capability: "Brave search + page fetch → dated evidence", impl: "IMPLEMENTED", verified: "CONTRACT_TESTED", evidence: "tests/adapters.test.ts", liveVia: "research.retrieval", dependency: "BRAVE_SEARCH_API_KEY", next: "CONNECT + TEST", done: "Research job stores sourced evidence" },
  { key: "drive", area: "DATA", capability: "Google Drive document import (optional)", impl: "IMPLEMENTED", verified: "CONTRACT_TESTED", evidence: "tests/adapters.test.ts", liveVia: "docs.google_drive", dependency: "Google OAuth client + refresh token", next: "Optional", done: "Doc imported as evidence" },
  { key: "publish", area: "CONTENT", capability: "WordPress publish with reconcile-before-retry", impl: "IMPLEMENTED", verified: "CONTRACT_TESTED", evidence: "tests/adapters.test.ts, tests/jobs.test.ts", liveVia: "publish.primary", dependency: "WordPress site + application password", next: "CONNECT + TEST; first publish needs your approval", done: "Confirmed receipt with remote URL" },
  { key: "analytics", area: "CONTENT", capability: "GA4 runReport ingestion (+ CSV import)", impl: "IMPLEMENTED", verified: "CONTRACT_TESTED", evidence: "tests/adapters.test.ts, tests/portability.test.ts (CSV)", liveVia: "analytics.primary", dependency: "GA4 property + OAuth", next: "CONNECT + TEST", done: "Observations ingested without duplicates" },
  { key: "affiliate", area: "AFFILIATES", capability: "Program evidence records, qualification gates, CSV reporting import", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/workflow.test.ts, tests/portability.test.ts", dependency: "Network API not in initial matrix", next: "—", done: "No program auto-qualified" },
  { key: "mcp", area: "AUTOMATIONS", capability: "MCP client (Streamable HTTP + stdio), registry, allowlist", impl: "IMPLEMENTED", verified: "CONTRACT_TESTED", evidence: "tests/mcp.test.ts (local stdio fake server)", dependency: "An MCP server you configure", next: "Register a server", done: "Discover + allowlisted call" },
  { key: "clone", area: "DATA", capability: "One-action brand clone with ID remapping", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/portability.test.ts", dependency: "—", next: "—", done: "Secrets/approvals/perf excluded" },
  { key: "portability", area: "DATA", capability: "JSON export/import (dry run), backup/restore", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/portability.test.ts", dependency: "—", next: "—", done: "Round-trip preserves records + assets" },
  { key: "auth", area: "SYSTEM", capability: "Operator password, sessions, localhost binding", impl: "VERIFIED", verified: "LOCAL_VERIFIED", evidence: "tests/auth.test.ts", dependency: "—", next: "Add HTTPS proxy before any network deployment", done: "Mutations require a session" },
  { key: "media", area: "MEDIA", capability: "Voice/video generation", impl: "NOT_IMPLEMENTED", verified: "NOT_VERIFIED", evidence: "Out of scope: WordPress articles do not need it", dependency: "—", next: "Only if a video format is chosen", done: "—" },
];

export function effectiveVerification(e: ImplEntry): VerifyState {
  if (!e.liveVia) return e.verified;
  const r = getDb().prepare("SELECT last_success_at, state FROM integrations WHERE id = ?").get(e.liveVia) as { last_success_at: string | null; state: string } | undefined;
  return r?.last_success_at && r.state === "CONNECTED" ? "LIVE_VERIFIED" : e.verified;
}
