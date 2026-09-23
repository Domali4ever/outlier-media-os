# Assumptions and source-of-truth notes

## Source of truth

- **The Google Drive document “Outlier Media OS — Master Blueprint & 4-Hour Build Sprint” was NOT accessible** during this build: there was no Drive connection. It has **not** been read. The build follows the self-contained Master Build Prompt v1.0. Once Drive is connected, you can import the blueprint as evidence (`DRIVE_IMPORT`) and reconcile any differences.
- **The project folder (`outlier-media-os`) was empty when inspected.** No prior export, database or content was found, so there was nothing to migrate or back up first.
- **Legacy identifiers** `content_cpap_pilot_001` and `job_commercial_qualification_001` were **not** created: no genuine records for them exist here.
  - `brand_cpap_travel` is used as the initial brand ID.
  - If you have a prior export, import it with `npm run import -- data.json --apply --legacy`. Its approvals, QA reports and completed jobs then become **unverified history** and are not honored. Programs are never promoted to qualified.

## Design decisions

| Area | Decision |
|---|---|
| Publishing format | WordPress articles (chosen by the operator). Voice/video is out of scope. |
| Research provider | Brave Search API plus direct page fetch (chosen by the operator). |
| AI provider | Anthropic Messages API (chosen by the operator). |
| Model ID | Set by you (`ANTHROPIC_MODEL`). The live test checks it against `/v1/models`. |
| Token prices | Must be entered by you. They weren't hard-coded because they change, and an unknown price can't be treated as permission to spend. |
| Initial market | `CA`, language `en`, currency `CAD` (editable in BRAND). |
| Avatar | “CPAP Travel Guide (AI)”, DRAFT. No invented credentials, personal use or medical identity. |
| Topic ideas | 8 ideas, labelled `UNRESEARCHED`. They are suggestions, not validated opportunities. |
| Editorial review | A recorded human review may stand in for AI editorial review. You can disable this route in SYSTEM › Automations. |
| First publication | Always an explicit operator action. Later items can be published by the worker only under an approved recurring-publication policy, and each item still needs its own approval. |
| Authentication | One operator password (scrypt hash) set on first run. Localhost-only by default. |
| Secrets | Environment references only (`.env.local` / process env). No database secret store. |
| Stack | Next.js 16 (App Router) + TypeScript; better-sqlite3; zod; @modelcontextprotocol/sdk; a separate `tsx` worker process; vitest. No other infrastructure. |

## Open implementation gaps (separate from missing credentials)

- The in-app Google OAuth consent flow is not built. You paste a refresh token (documented).
- There is no affiliate network API adapter. Reporting uses CSV import by design for v1.
- There is no formal accessibility audit.
- No experiments feature. The “completed experiments” metric is omitted, since the prompt only asks for it “where implemented”.
