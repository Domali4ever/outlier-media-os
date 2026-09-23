---
name: workflow-contract-tests
description: "Use when adding or changing tests for content workflow gates, approvals, jobs, provider adapters, persistence, export/import, or MCP contracts in this repository."
---

# Workflow Contract Tests

1. Identify the owning core service or adapter and read the nearest existing test before editing.
2. Use `freshDb()` from [tests/helpers.ts](../../../tests/helpers.ts) for an isolated temporary SQLite database.
3. Use real core functions and real database operations. Fake only external HTTP or MCP boundaries with `fakeFetch()` or the existing fixture server.
4. Build valid workflow state with `readyItem()` when the test needs a READY content item; do not bypass gates with direct SQL.
5. Assert both the successful path and the controlling rejection or blocked state. For provider tests, assert request shape and translated error properties.
6. Keep secrets, live credentials, and network calls out of tests.
7. Run the narrowest relevant Vitest file first, then `npm test` and `npm run typecheck` when shared behavior changed.

Useful test areas:

- `tests/workflow.test.ts`: stage transitions, approvals, and commercial gates
- `tests/jobs.test.ts`: claiming, idempotency, leases, retries, and blocking
- `tests/adapters.test.ts`: provider requests and error translation
- `tests/persistence.test.ts`: restart and database behavior
- `tests/portability.test.ts`: backup, export, import, and restore
- `tests/mcp.test.ts`: MCP discovery and execution contracts
