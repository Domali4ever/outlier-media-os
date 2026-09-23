# Integration matrix and connection checklist

The app needs its **own** authorized connection to each provider. Connectors you use inside ChatGPT or Claude are not available to this application.

A saved key is not proof that a connection works. `CONNECTED` is only set after the acceptance check below passes against the real provider. Read access is never presented as publish access.

Provider consoles change over time. Treat the account steps below as a checklist, and confirm each step against the provider's current documentation when you do it.

## Integration matrix (initial, bounded: one provider per capability)

| Capability key | Provider | Transport / API | Auth | Permissions needed | Acceptance check (run by TEST) | Implementation | Verification in repo | Live |
|---|---|---|---|---|---|---|---|---|
| `ai.structured_generation` | Anthropic | Messages API, `POST /v1/messages` with one forced tool call; output validated with zod | `x-api-key` | Workspace API key | `GET /v1/models` lists `ANTHROPIC_MODEL` | Implemented | Contract-tested (fake HTTP) | Not verified |
| `research.retrieval` | Brave Search API, plus a direct page fetch | `GET /res/v1/web/search` | `X-Subscription-Token` | Web Search plan | Search for “cpap travel case” returns results | Implemented | Contract-tested | Not verified |
| `docs.google_drive` (optional) | Google Drive API v3 | `files.get`, `files.export` (text/plain) | OAuth 2.0 refresh token | `drive.readonly` | Token refresh plus `GET /drive/v3/about?fields=user` | Implemented | Contract-tested | Not verified |
| `publish.primary` | WordPress REST API | `POST /wp-json/wp/v2/posts`; reconcile with `GET …/posts?slug=` | Application password (Basic auth, HTTPS only) | User with `publish_posts` | `GET /wp-json/wp/v2/users/me?context=edit` authenticates **and** reports `publish_posts`. Nothing is published by the test | Implemented | Contract-tested | Not verified |
| `analytics.primary` | Google Analytics 4 Data API v1beta | `properties/{id}:runReport` (pagePath × date → views, users) | OAuth 2.0 refresh token | `analytics.readonly` plus Viewer on the property | `runReport` for the last 7 days succeeds | Implemented | Contract-tested | Not verified |
| `affiliate.reporting` | CSV import (built in) | Local file | — | — | Local test: validate, dedupe, map | Implemented | Locally verified | n/a (local) |
| `media.voice_video` | — | — | — | — | Out of scope: WordPress articles don't need it | Not implemented (out of scope) | — | — |
| MCP (any server you add) | Your server | Streamable HTTP or stdio (MCP TypeScript SDK) | Header or env **names** that point to `.env.local` | Allowlisted per tool, with a level 0–3 | `tools/list` succeeds (DISCOVER) | Implemented | Contract-tested (local fake stdio server) | Not verified |

Not in the initial matrix: an affiliate network reporting API. Affiliate discovery runs as a research job (FIND OFFERS). Qualification, account status and link activation are operator records backed by evidence.

---

## Checklist

Fill in `.env.local` (copy it from `.env.example`). You don't need to restart after editing it. Then go to **SYSTEM › Connections** and press **CONNECT**. If the test fails, the reason appears under **View error**.

### 1. Anthropic (AI): required for research, scripts, editorial review, FIND OFFERS and natural-language commands

1. Create an API key in the Anthropic Console for the workspace you want billed.
2. Set these in `.env.local`:
   - `ANTHROPIC_API_KEY`
   - `ANTHROPIC_MODEL`: a model ID your key can use. TEST lists the available IDs if the one you set is wrong.
   - `ANTHROPIC_PRICE_INPUT_PER_MTOK`, `ANTHROPIC_PRICE_OUTPUT_PER_MTOK`, `ANTHROPIC_PRICE_CURRENCY`: copy these from Anthropic's current pricing for that model. Paid jobs stay blocked without them.
3. **SYSTEM › AI › CONNECT.** It's verified when the state is `CONNECTED` and the result reads “model … available”.
4. **SYSTEM › Automations › Set cap:** a monthly amount in the same currency as the prices.
5. **BRAND:** approve the avatar, then **Activate**.
6. First live verification: on an idea, press **Generate research**. The job should reach `COMPLETE` with sources attached.

### 2. Brave Search API (research retrieval): required for research and FIND OFFERS

1. Subscribe to a Brave Search API plan that includes Web Search, then create an API key.
2. Set `BRAVE_SEARCH_API_KEY`.
3. **SYSTEM › Data › CONNECT.**

Pages are fetched directly from their source sites, and each page is stored with its URL, the date it was fetched and a SHA-256 hash.

### 3. WordPress (publishing destination)

1. The site must be on HTTPS and have REST API and Application Passwords enabled. Some hosts and security plugins disable these; turn them back on if so.
2. Use (or create) a WordPress user whose role can publish posts (Author, Editor or Administrator).
3. Go to **Users › Profile › Application Passwords**, enter a name (for example “Outlier Media OS”) and create one. Copy it once.
4. Set `WP_BASE_URL` (the site root, e.g. `https://example.com`), `WP_USERNAME` and `WP_APP_PASSWORD`.
5. **SYSTEM › Content › CONNECT.** The test proves you can authenticate and that WordPress reports `publish_posts`. It publishes nothing.
6. **First live publish is your explicit action.** When an item is READY:
   1. Open it and press **PUBLISH**.
   2. The job posts the approved revision with a deterministic slug and records the returned post ID and URL.
   3. Check the live page. That completes live verification of `publish.primary`.

   If the request times out, the worker searches for that slug before any retry, so you won't get duplicate posts.

To publish by hand instead: publish in WordPress yourself, then use **PERFORMANCE › Record manual publication** with the live URL and your proof.

### 4. Google Drive (optional) and GA4 (analytics)

Both use the same Google OAuth client.

1. In Google Cloud, create a project. Enable the **Google Drive API** (optional) and the **Google Analytics Data API**.
2. Configure the OAuth consent screen and add your own Google account as a user.

   > **Refresh tokens expire:** while the consent screen is in *Testing* status, Google refresh tokens expire after about 7 days. Publish the app (you don't need verification for your own use of these scopes) to get tokens that last.
3. Create an OAuth client ID. Use the “Desktop app” type, or “Web application” with the OAuth Playground redirect URI.
4. Get a refresh token for the scopes below, for example with the Google OAuth 2.0 Playground set to “Use your own OAuth credentials”:
   - `https://www.googleapis.com/auth/analytics.readonly`
   - `https://www.googleapis.com/auth/drive.readonly` (only if you use Drive)
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` and `GA4_PROPERTY_ID`. The property ID is the numeric ID in GA4 **Admin › Property details**, and your account needs at least Viewer access to that property.
6. **SYSTEM › Content (analytics) › CONNECT**, and **SYSTEM › Data (Drive) › CONNECT** if you use Drive.
7. Analytics sync runs daily once analytics is connected and something is published. You can also type `pause workflow ANALYTICS_SYNC` or `resume workflow ANALYTICS_SYNC` in the command box.

If you don't want to connect GA4, use **BRAND › Reporting import** with a CSV export.

The in-app OAuth consent flow is **not** built. You paste a refresh token that you obtained yourself (see `ASSUMPTIONS.md`).

### 5. Affiliate programs (no connection; operator evidence)

- **FIND OFFERS** (needs AI + Brave) records programs as `DISCOVERED`, with page-quoted facts marked `UNVERIFIED`.
- You verify each of the 12 criteria (source URL + checked date + evidence), then press **Qualify**.
- **Applying to a program or accepting its terms is done by you, outside the app (Level 4).** Afterwards, record the account status in the app.
- A live link can only be activated when all of these are true: the program is `QUALIFIED`, the account is `APPROVED`, the offer is `VALID` with a disclosure.
- For reporting, map your network's export to the documented CSV columns and use **BRAND › Reporting import** (dry run first).

### 6. MCP servers (optional)

1. **SYSTEM › Connections › Add MCP server.**
   - HTTP servers must use HTTPS (localhost excepted). Put the Authorization value in `.env.local` and enter only its **variable name**.
   - For stdio servers, enter the command and arguments, plus the names of any environment variables to pass through.
2. **Discover tools**, then allowlist individual tools at level 0–3. Nothing is callable until it's allowlisted. Level 4 is never delegated to a tool.
3. Tool output is treated as untrusted data.

## Never done automatically

The app never does any of the following on its own: register accounts, accept terms, apply to programs, publish content (the first publication, and every publication without a recurring-publication policy), contact third parties, or incur spending above your cap.
