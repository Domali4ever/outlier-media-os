---
name: core-business-rules
description: "Use when changing business rules, permissions, workflow transitions, jobs, approvals, commercial gates, persistence, or migrations under src/core."
applyTo: "src/core/**/*.ts"
---

# Core Business Rules

- Keep this layer independent of Next.js UI and provider adapters.
- Treat `src/core/types.ts` as the source for shared states, stages, permission levels, risks, and IDs.
- Enforce rules in core functions, not only in forms, server actions, or worker code. Direct callers must receive the same validation.
- Preserve auditability: use existing audit, error, timestamp, and stable-ID conventions.
- For schema changes, add a versioned migration in `src/core/migrations.ts`; do not alter the schema ad hoc at runtime.
- For job changes, preserve idempotency keys, block reasons, leases, retry/backoff behavior, and side-effect state.
- For content changes, preserve revision-bound approval invalidation and stage transition gates.
- Add or update focused tests using isolated databases before widening validation to the full suite.
- Consult [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the state model and [docs/ASSUMPTIONS.md](../../docs/ASSUMPTIONS.md) for source-of-truth decisions.
