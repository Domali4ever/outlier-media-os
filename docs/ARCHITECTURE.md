# Architecture and data model

## Processes

```
browser ──HTTPS/HTTP (localhost)──▶ Next.js app (web)            worker (tsx worker/index.ts)
                                     │ server components               │ poll every 2 s
                                     │ server actions (/app/actions)   │ recover expired leases
                                     │ route handlers (/api/*)         │ release BLOCKED jobs whose deps are met
                                     ▼                                 │ claim → recheck → execute → record
                               src/core (business rules) ◀─────────────┘
                                     │
                               SQLite (data/outlier.db, WAL) + data/assets/
```

`npm start` (`scripts/run.mjs`) runs migrations, then starts both processes. The two processes only share the database. The worker writes its heartbeat to `settings.worker_heartbeat`, and the header shows it.

## Layers

| Layer | Path | Rule |
|---|---|---|
| Core services | `src/core/` | All business rules, permissions, transitions and gates. Independent of UI and providers. |
| Provider adapters | `src/adapters/` | Request/response mapping, auth, timeouts, error translation (`ProviderError`). No business rules. |
| Job modules | `src/modules/` | Research, Script/Revise, QA, Affiliate (Find offers), Publish, Analytics, Drive, MCP. They call core services plus adapters. |
| Worker | `worker/index.ts` | Durable queue loop plus recurring scheduling (`src/core/automation.ts`). |
| UI | `src/app/`, `src/components/` | Four screens. Every mutation goes through one server action dispatcher (`act`) that calls core services. |
| Prompts | `prompts/*.md` | Every model instruction lives in the repo. |

## Workflow

Buyer problem → opportunity → research → commercial evaluation → content → QA → approval → readiness → publication → measurement → recommendation.

The stages are: `IDEA → RESEARCH → SCRIPT → QA → APPROVAL → READY → PUBLISHED → MEASURE`. Stages advance one step at a time. `src/core/content.ts › checkTransition` checks each move:

| Move | Gate |
|---|---|
| → SCRIPT | At least one dated evidence item, or research completed |
| → QA | A script of 200+ characters on the current revision (RUN QA makes this move automatically when the gate passes) |
| → APPROVAL | Deterministic QA not failing **and** (AI editorial review, or a recorded human review) on the current revision; no unresolved high-risk claims; risk ≠ BLOCKED |
| → READY | An active approval bound to the current revision, destination and commercial hash; commercial clearance (qualified program + approved account + valid offer + active link, or an explicit NO_OFFER) |
| → PUBLISHED | Never by moving. Only a confirmed provider receipt (PUBLISH job) or a manual publication with evidence |
| → MEASURE | At least one observation, or analytics CONNECTED |

Moving backwards is allowed up to READY. Published items cannot move back; they can be retired instead.

Readiness is tracked separately for **editorial**, **commercial**, **publication** and **measurement**.

## Approvals

Stored in `approvals`. A content approval records `revision_id`, `destination` and `commercial_hash`, which is the hash of the commercial decision plus the offer ID, affiliate URL and disclosure.

An approval stops being honored when:
- a new revision is saved (it is marked INVALIDATED),
- the destination or commercial configuration changes (INVALIDATED), or
- the recomputed hash no longer matches.

Old approval records are kept for the audit trail.

## Jobs

`jobs` table:
- **States:** QUEUED, BLOCKED, RUNNING, RETRYING, COMPLETE, FAILED, NEEDS_ATTENTION, CANCELLED.
- **Fields:** idempotency key (unique), attempts/max, `run_after` (backoff), lease owner/expiry and heartbeat, `side_effect_state` (NONE, REQUESTED, CONFIRMED, AMBIGUOUS), usage and cost estimate, structured error, correlation ID.
- **Events:** `job_events` records every change.

Behaviour:

- **Creation:** an identical active key returns the existing job. `blockReasons` lists every unmet dependency (capability state, brand ACTIVE, spend cap, token prices, approval for level 3+). If any exist the job is created BLOCKED with those reasons.
- **Claiming:** a single `UPDATE … WHERE state IN (QUEUED, RETRYING)` inside a transaction. Paused types, paused/archived brands and a system pause are all respected.
- **Execution:** the worker re-checks `blockReasons` plus content existence immediately before running. The Publish module also re-checks the revision, approval, stage and commercial clearance.
- **Failures:**

  | Failure | Result |
  |---|---|
  | Auth failure | Integration DEGRADED, job BLOCKED |
  | Transient failure | RETRYING with exponential backoff |
  | Business-rule failure | FAILED |
  | Side effect possibly delivered (timeout after POST) | PUBLISH: RETRYING, and the next attempt **reconciles by deterministic slug** before posting again. Other side effects: NEEDS_ATTENTION |

- **Restart recovery:** RUNNING jobs whose lease has expired are recovered using the same rules.

## Permissions

| Level | Meaning |
|---|---|
| L0 | Observe |
| L1 | Prepare: research, drafts |
| L2 | Reversible internal updates |
| L3 | Commercial: publish. Needs an approval ID, and non-operators need one explicitly |
| L4 | Human only: approvals, program/account decisions, policies, activation, link activation |

Core functions reject L4 actions from any actor except `operator`. Recurring publication runs under an ACTIVE `recurring_publication` policy. It only applies after the brand's first publication, and each item still needs its own approval.

Spending: paid jobs need an ACTIVE `budget` policy **and** configured token prices in the same currency. Unknown pricing blocks the job; it never allows unlimited spend.

## Data model (tables)

| Group | Tables |
|---|---|
| Settings and auth | `settings`, `sessions` |
| Brand | `brands`, `pillars`, `avatars` |
| Content | `content_items`, `content_revisions`, `evidence`, `claims`, `qa_reports`, `approvals` |
| Commercial | `programs`, `commercial_facts` (unique per program × criterion, with source URL, checked date, evidence and status), `offers` |
| Integrations | `integrations` (capability-keyed; secret env-var names only), `mcp_servers` |
| Jobs and audit | `jobs`, `job_events`, `audit_events` |
| Outcomes | `publications`, `performance_observations` (unique `ingest_key` = source + subject + metric + original period), `costs` (`is_estimate` flag), `recommendations` (rule key, data sufficiency) |
| Policy | `policies` (versioned), `checkins` |

Conventions: all timestamps are UTC ISO-8601; money carries explicit currency codes; brands carry market and language. Stable IDs are prefixed (`content_…`, `job_…`, `approval_…`).

Schema changes go through versioned migrations in `src/core/migrations.ts`, recorded in `schema_migrations`.

## Metrics honesty

`src/core/today.ts` labels every tile with one of: MEASURED, NOT_CONNECTED, NO_DATA, STALE, PARTIAL, ESTIMATED or NOT_CALCULABLE.

- Profit is only shown when revenue is measured, and even then it is labelled PARTIAL.
- "Nothing else needs your attention" only appears when there are no decisions and no failed jobs, and every required provider is connected.

## Portability

| Feature | Implementation |
|---|---|
| Export | `omos.export.v1` JSON (all tables except sessions, password hash and heartbeat) |
| Import | Dry run first; inserts only, never overwrites. Legacy mode downgrades approvals, completions and qualifications to unverified history |
| Backup | Online SQLite `backup()` plus assets plus manifest |
| Restore | Keeps a safety copy |
| Clone | New IDs; provenance kept; excludes credentials, approvals, publications, performance, costs and jobs; starts DRAFT; commercial facts copied as UNVERIFIED with their original source and date |
