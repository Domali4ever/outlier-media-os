# Acceptance report: v1.0 (initial delivery, 2026-09-23)

**Where this was run:** Linux build sandbox, Node 22.22, Next.js 16.3.6, better-sqlite3 12.11.1.
**Not yet run on:** the operator's Windows machine. See “Unverified” below.

**How to read the Verified column:**

| Term | Meaning |
|---|---|
| Automated | The vitest suite (`npm test`, 47 tests, isolated temporary databases) |
| Scripted UI run | A Playwright session driving the running app with the real worker (script not included in the repo) |
| Contract | Tested against isolated fake providers. **Not live.** |

| # | Check | Result | Verified by |
|---|---|---|---|
| 1 | Clean install, migrations, build, startup from the repository | **Passed** | `npm install` → `npm run migrate` → `next build` (no type or compile errors) → `npm start` brings up web + worker; `/api/health` reports `worker: alive` |
| 2 | Data survives browser refresh and app/worker restart | **Passed** | `tests/persistence.test.ts`; manual restart: content, the blocked job and the check-in were still present |
| 3 | Real CRUD, revision history, filters and details on all four screens | **Passed** | Scripted UI run: first-run password, avatar approval, brand activation, content creation, job creation, board move (refused and allowed), command box, CONNECT, backup, check-in; screenshots of every screen at 1440 px and 390 px |
| 4 | RUN creates a durable job that the worker claims and records | **Passed** | `tests/jobs.test.ts` (“worker executes a local job end to end”); UI run showed the job ID and its live state |
| 5 | Worker recovery and duplicate protection | **Passed** | `tests/jobs.test.ts`: exclusive claiming, idempotent creation, expired-lease recovery, exhausted attempts → FAILED |
| 6 | Missing providers produce accurate blocked states, never fake success | **Passed** | `tests/jobs.test.ts` (exact reasons listed; connecting providers alone doesn't release paid jobs); UI shows NOT CONNECTED / BLOCKED |
| 7 | Server-side approval checks resist direct-request bypass; edits invalidate approvals | **Passed** | `tests/workflow.test.ts` (non-operator approvals refused, stale-revision approval refused, edits and offer changes invalidate approvals); unauthenticated `/pipeline` → redirect, `/api/export` → 401 |
| 8 | Publishing needs connection + revision approval + commercial/policy gates | **Passed (contract)** | `tests/workflow.test.ts`, `tests/jobs.test.ts` (fake WordPress): BLOCKED without connection; worker re-checks the revision; PUBLISHED only from a receipt or manual evidence |
| 9 | Provider failures, timeouts and ambiguous side effects handled safely | **Passed (contract)** | `tests/adapters.test.ts`, `tests/jobs.test.ts`: 401 → DEGRADED + BLOCKED; 429/5xx retryable; a timeout after POST reconciles by slug, with exactly one POST |
| 10 | Metrics distinguish unknown, stale, partial, estimated and measured | **Passed (by review)** | `src/core/today.ts` labels every tile; profit is never computed from unknown revenue. There is no dedicated unit test for the tile labels |
| 11 | Cloning remaps IDs and excludes secrets and operational authorizations | **Passed** | `tests/portability.test.ts` |
| 12 | Export/import and full backup/restore preserve records and assets | **Passed** | `tests/portability.test.ts` (dry run, round trip, legacy mode, backup → mutate → restore incl. assets) |
| 13 | Secrets absent from client output, logs, exports and tracked files | **Passed** | Export test; `redact()` checked on key/Basic/Bearer/JSON forms; `.next/static` contains no secret names or values; `.env.local`, `data/` and `backups/` are git-ignored |
| 14 | Keyboard and common desktop/mobile layouts | **Partially verified** | All controls are native buttons, links or form fields with labels; drag has a keyboard alternative; no horizontal scroll at 390 px. No formal WCAG audit or screen-reader test was done |

## Unverified: needs your accounts or machine

- **All live provider behaviour:** Anthropic, Brave, WordPress, Google Drive, GA4 and any MCP server. Their state is `NOT_CONNECTED`, and the implementation register shows `CONTRACT_TESTED`. It switches to `LIVE_VERIFIED` automatically only after a real successful call.
- **Windows:** install and run (native `better-sqlite3` binary, the `npm start` process runner).
- **The first end-to-end content loop** (research → script → editorial review → approval → publish → analytics). This can only run after the connections in `CONNECTIONS.md` are set up.
- **The natural-language command path.** It needs the AI provider.

## Failures

None open in the automated suite. Problems found and fixed during acceptance:
- Deterministic QA treated Markdown link text as a placeholder.
- A default restricted phrase (“medical advice”) collided with the required disclaimer.
- Log redaction mangled plain text that contained the word “password”.
- The header wrapped at 1440 px.
- A 401 on publish was being treated as an ambiguous side effect.

## Known limitations (not missing credentials)

- The Google OAuth consent flow is not built into the app. You supply a refresh token (see `CONNECTIONS.md`).
- Affiliate network reporting APIs are not in the initial matrix. Reporting comes in by CSV import.
- Recommendation rules are simple, documented thresholds (`src/core/recommendations.ts › RULES`). They use stored data only.
- Single operator, single worker, SQLite. Not built for multi-user or horizontal scaling.
- The Next.js build prints two harmless file-tracing warnings about dynamic data paths. They don't affect `next start`.
