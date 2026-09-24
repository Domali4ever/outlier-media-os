# Outlier Media OS

A local-first operating console for an evidence-based affiliate content business. The first brand is **CPAP Ownership + Travel** (`brand_cpap_travel`).

The app has four screens: **TODAY**, **PIPELINE**, **BRAND** and **SYSTEM**. It also includes a persistent SQLite database, a separate job worker, server-side approval and commercial gates, provider adapters (Anthropic, Brave Search, WordPress, Google Drive, GA4 and MCP), cloning, and export/import/backup/restore.

> **Status:** the application is implemented and tested locally. No external accounts are connected yet. Every capability that depends on an outside provider stays `BLOCKED` with a stated reason until you connect it and its live test passes. See `docs/ACCEPTANCE.md` for what is verified and what is not.

---

## Requirements

- Node.js 20.9 or newer (22 LTS recommended) and npm.
- Windows, macOS or Linux. `better-sqlite3` ships prebuilt binaries for common platforms; if your platform has none, npm builds it from source, which needs build tools.

## Install, build, run

```bash
npm install          # uses the committed package-lock.json
npm run migrate      # creates data/outlier.db, applies migrations, seeds the initial brand (idempotent)
npm run build        # production build
npm start            # ONE command: runs migrations, then starts the web app AND the worker
```

Then open http://127.0.0.1:3000. On first visit you set the operator password (12+ characters).

`npm run setup` runs install + migrate + build in one step.

For development with hot reload, use `npm run dev`. It also starts the web app and the worker together.

**Jobs run in the worker process**, not in the browser. Closing the tab doesn't stop them. They only run while this computer is awake and `npm start` (or `npm run worker`) is running. Nothing runs while the machine is asleep or off.

## Test

```bash
npm test             # vitest: 47 tests over isolated temporary databases
npm run typecheck
```

Tests that talk to "providers" use **isolated fake HTTP responses or a local fake MCP server** (see `tests/helpers.ts` and `tests/fixtures/`). They check request shape and error handling (contract tests). They are **not** live verification.

## Configuration and connections

1. Copy `.env.example` to `.env.local`.
2. Fill in the values for the provider you want to connect.
3. In **SYSTEM**, press **CONNECT**. This checks the values are present and then runs the provider's real, read-only acceptance test.
4. The integration only becomes `CONNECTED` if that test passes.

Step-by-step account setup is in `docs/CONNECTIONS.md`.

Before any AI job runs you also need:
- **BRAND:** an approved avatar, then the brand activated.
- **SYSTEM › Automations:** a monthly spend cap.
- **`.env.local`:** the AI token prices set, so spending can be checked against the cap.

## Data locations

| What | Default path | Override |
|---|---|---|
| Database (SQLite, WAL mode) | `data/outlier.db` | `DATA_DIR` or `DB_PATH` |
| Evidence files, Drive imports | `data/assets/` | `DATA_DIR` |
| Backups | `backups/backup-<timestamp>/` | `BACKUP_DIR` |
| Exports | `exports/export-<timestamp>/` | `EXPORT_DIR` |

All of these are git-ignored. Keep `data/` on persistent storage.

## Backup, export, import, restore

```bash
npm run backup                       # consistent online SQLite snapshot + assets + manifest
npm run export                       # exports/<ts>/data.json (omos.export.v1) + assets/
npm run import -- path/to/data.json            # dry run (default): validates, reports counts
npm run import -- path/to/data.json --apply    # inserts new rows; never overwrites existing IDs
npm run import -- path/to/data.json --apply --legacy   # prior approvals/QA/jobs become unverified history
```

**Restore:**

1. Stop the app first (Ctrl+C).
2. Run `npm run restore -- backups/backup-<timestamp>`. The current database is kept next to it as `outlier.db.pre-restore-<ms>`, and the current assets folder is renamed rather than deleted.
3. Start again with `npm start`.

The same backup, export and import actions (dry run by default) are available in **SYSTEM › Backup**. Exports never contain secret values or the operator password hash.

## Security model

- The server binds to `127.0.0.1` by default. Binding anywhere else is refused unless `ALLOW_NETWORK=1`.
- Every page, API route and mutation requires the operator session. The password is stored as a scrypt hash. Session cookies are httpOnly and SameSite=strict. Repeated failed logins are rate-limited.
- Permissions, approvals, stage transitions and commercial gates are enforced in `src/core/*`. The same rules apply to the UI, direct requests, commands, the worker and MCP-triggered actions.
- Secrets are only ever read server-side from environment values or `.env.local`. They never go to the browser, the database or exports. Logs and errors pass through `redact()`.

## Deployment (beyond this machine)

This is a single-operator, local-first app. To put it on a network:

- Run it behind an HTTPS reverse proxy and set `ALLOW_NETWORK=1`, `HOST=0.0.0.0` and `COOKIE_SECURE=1`.
- Put `DATA_DIR` on a persistent volume. **Never** use an ephemeral filesystem, because SQLite and the assets would be lost.
- Run exactly one worker per database.
- This is not a multi-user or horizontally scalable deployment.

## Documentation

- `docs/ARCHITECTURE.md`: architecture and data model
- `docs/OPERATOR_GUIDE.md`: everyday use and approvals
- `docs/CONNECTIONS.md`: connection checklist and integration matrix
- `docs/ACCEPTANCE.md`: acceptance report (passed, failed, unverified)
- `docs/ASSUMPTIONS.md`: assumptions, source-of-truth notes, open gaps
- `docs/COMMERCE.md`: provider-neutral commerce model and Whop rollout boundary
- `docs/LICENSES.md`: dependency licences
- `prompts/`: every AI prompt used by the app
