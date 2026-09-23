# Operator guide

## Daily routine (about 5 minutes)

1. **TODAY:** read *Since last check-in*. Every number carries a label:

   | Label | Meaning |
   |---|---|
   | MEASURED | Real data from a connected or imported source |
   | NOT CONNECTED | No source exists for this number yet |
   | NO DATA | A source exists but hasn't returned anything |
   | STALE | The last sync is old |
   | PARTIAL | Some sources or costs are missing |
   | ESTIMATED | Computed (e.g. AI cost from tokens), not billed |
   | UNKNOWN | Not calculable; never shown as zero |
2. Work through **Needs your decision**. It lists recommendations (SCALE / MAINTAIN / MODIFY / KILL / INVESTIGATE), approvals waiting on you, and jobs that need attention.
3. Do the **Next recommended action**. **RUN** creates a real job and shows its progress. **OPEN** takes you to whatever is blocking it.
4. Press **Record check-in** so the next summary starts from now.

The attention bar only says “Nothing else needs your attention” when that is actually true. If providers are disconnected, it tells you monitoring is partial.

## Taking an idea to publication

1. **PIPELINE › open an idea › Generate research.** Sources are stored as evidence with their fetch dates. Claims are extracted as `UNVERIFIED`.
2. **Review the claims (SCRIPT tab).**
   - SAFETY, ELECTRICAL, COMPATIBILITY, AIRLINE, MANUFACTURER and MEDICAL claims block the item until you set them to VERIFIED (citing dated evidence), NOT_APPLICABLE, or remove them from the text.
3. **Generate script**, or write the article yourself. Every save creates a new revision and invalidates approvals on older revisions.
4. **COMMERCIAL tab:** choose a target offer, or record **No offer**.
5. **QA tab:**
   - **Run QA** runs structural checks: disclosures, restricted phrases, placeholders, evidence, claims.
   - Then run **AI editorial review**, or **Record human editorial review** after reading it yourself.
   - A structural PASS is not a factual or medical review.
6. **Advance to APPROVAL**, read the revision, then **Approve rev N**. The approval is tied to that revision, the destination and the offer. If anything changes, you approve again.
7. **Mark ready**, then **Publish** (needs WordPress connected), or publish by hand and **Record manual publication** with proof.
8. Measurement starts once analytics is connected or you import a report.

Dragging cards on the board asks the server for the same move; illegal moves are refused and the reason is shown. The keyboard alternative is the **Workflow actions** panel on each item.

## Commands (header box)

Structured commands always work. Type `help` to see them all:

- `show approvals`, `show failed jobs`, `show blocked jobs`
- `open <id>`, `search <text>`
- `pause workflow <TYPE>`, `resume workflow <TYPE>`, `pause all`, `resume all`
- `run qa <id>`, `generate research <id>`, `generate script <id>`
- `check in`

Natural-language requests need the AI provider. They are turned into one of the commands above, and anything that changes state asks you to confirm first. No command can publish, approve, spend beyond your cap or apply to programs.

## What only you can do (Level 4)

These actions are always yours:

- Approve content, avatars and policies.
- Activate, pause or archive brands.
- Qualify programs and record account status.
- Activate live links.
- Set spend caps and the recurring-publication policy.
- Start the first publication.
- Restore backups.

## SYSTEM

| Section | What it holds |
|---|---|
| Connections | CONNECT / TEST / PAUSE / RETRY / DISABLE / VIEW ERROR per provider; MCP servers |
| Automations | Spend cap, recurring-publication policy, human-review route, per-workflow pause |
| Jobs | Filter by state; open a job to see its events, attempts, side-effect state and output; Cancel / Retry |
| Backup | Back up now, export, download JSON, import (dry run by default), change password |
| Log | The structured event log |
| System details toggle | Shows implementation and verification status. It changes nothing about behaviour |

## When something fails

- **Auth failures** mark the integration DEGRADED and block its jobs. Fix the credential, then press **TEST**; blocked jobs resume on their own.
- **Transient failures** retry with backoff up to the job's attempt limit.
- A **publish timeout** is treated as “may have happened”: the next attempt checks WordPress for the post before posting again. Anything else ambiguous stops as NEEDS_ATTENTION for you to review.
- **Drafts are never lost** because a provider failed. Revisions are saved locally before any external call.

## Cloning a brand

**BRAND › Clone brand:** set a name, market, language and currency.

- The clone starts in DRAFT with a DRAFT avatar, IDEA templates and program facts marked UNVERIFIED (their original source and date are kept).
- Nothing operational is copied: no credentials, approvals, publications, performance data or jobs.
- Select the clone from the header's brand selector and activate it when it's ready.
