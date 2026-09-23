# Dependency licences

The application source in this repository belongs to the operator. The third-party dependencies below keep their own licences; this project does not claim ownership of them. Versions are pinned in `package-lock.json`.

| Package | Version | Licence | Role |
|---|---|---|---|
| next | 16.3.6 | MIT | Web framework |
| react / react-dom | 19.3.0 | MIT | UI |
| better-sqlite3 | 12.11.1 | MIT | SQLite driver (bundles SQLite, public domain) |
| zod | 4.6.5 | MIT | Schema validation |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | MCP client (and the test-only fake server) |
| tsx | 4.23.15 | MIT | Runs the worker and scripts |
| server-only | 0.0.1 | MIT | Keeps server modules out of client bundles |
| typescript (dev) | 5.9.3 | Apache-2.0 | Type checking |
| vitest (dev) | 5.0.1 | MIT | Tests |
| @types/* (dev) | — | MIT | Type definitions |

Fonts: IBM Plex Sans and IBM Plex Mono are loaded from Google Fonts (SIL Open Font License 1.1). Offline, the app falls back to system fonts.

Transitive dependencies: run `npx license-checker --summary` (not installed by default) for a full list.
