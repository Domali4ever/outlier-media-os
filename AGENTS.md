# Outlier Media OS Agent Guide

## Start Here

- Read [README.md](README.md) for setup, configuration, operations, and deployment constraints.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing workflow, jobs, permissions, or persistence.
- Read [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) when assessing whether behavior is verified.
- Keep operational details in [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) and provider setup in [docs/CONNECTIONS.md](docs/CONNECTIONS.md).

## Commands

- Install and initialize: `npm install`, then `npm run migrate`.
- Validate code: `npm test` and `npm run typecheck`.
- Build and run: `npm run build`, then `npm start`; use `npm run dev` for hot reload.
- `npm start` runs migrations and starts both the Next.js web process and the worker. Use one worker per database.
- Tests must not call live providers. Use the helpers in [tests/helpers.ts](tests/helpers.ts) and the existing test patterns.

## Architecture Rules

- Put business rules, permissions, workflow transitions, commercial gates, and persistence operations in `src/core/`. Keep them independent of UI and providers.
- Keep request/response mapping, authentication, timeouts, and provider error translation in `src/adapters/`. Do not put business rules there.
- Use `src/modules/` for job orchestration that composes core services and adapters.
- Route UI mutations through [src/app/actions.ts](src/app/actions.ts); core services must still enforce the rules for every caller.
- Keep model instructions in `prompts/` and update the relevant prompt when changing an AI workflow.
- Schema changes require a versioned migration in [src/core/migrations.ts](src/core/migrations.ts).

## Safety-Critical Invariants

- Never trust client-side checks. Re-check authentication, permissions, approvals, workflow gates, and commercial readiness server-side.
- Never expose secrets to browser code, the database, exports, or logs. Read them only server-side and pass sensitive values through `redact()`.
- Preserve content stage gates and revision-bound approvals. Saving a revision or changing commercial configuration can invalidate approval.
- Preserve job idempotency, leases, retry semantics, `blockReasons`, and side-effect reconciliation. Publishing must not duplicate a possibly delivered request.
- Use UTC ISO-8601 timestamps, explicit currency codes, and stable prefixed IDs consistent with existing core types.
- Keep the default localhost binding. Network exposure requires the documented security configuration in [README.md](README.md).

## Testing Guidance

- Prefer focused tests near the changed behavior, then run `npm test` and `npm run typecheck` when the change spans shared core behavior.
- Exercise real core services with an isolated temporary SQLite database; fake only external HTTP or MCP boundaries.
- Update tests when changing a gate, state transition, adapter contract, job state, migration, export/import behavior, or security boundary.

## Scope Discipline

- Make the smallest change that preserves the existing layer boundaries and public behavior.
- Do not invent credentials, live provider results, medical claims, or external account state.
- Link to existing documentation rather than duplicating detailed procedures here.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
