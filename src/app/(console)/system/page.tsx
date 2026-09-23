import { listAudit } from "@/core/audit";
import { selectedBrandId } from "@/core/brand";
import { currentSchemaVersion, dbPath, assetsDir } from "@/core/db";
import { effectiveVerification, IMPLEMENTATION } from "@/core/implementation";
import { listIntegrations } from "@/core/integrations";
import { getJob, jobCounts, jobEvents, JOB_TYPES, listJobs, workerStatus } from "@/core/jobs";
import { activePolicy, budgetStatus } from "@/core/policies";
import { backupsDir } from "@/core/portability";
import { allowHumanEditorialReview, getSetting, isSystemPaused, pausedJobTypes } from "@/core/settings";
import { JOB_STATES } from "@/core/types";
import { parseJson } from "@/core/util";
import { listMcpServers } from "@/adapters/mcp";
import { systemDetailsOn } from "@/lib/session";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Chip } from "@/components/Chip";
import { JobWatch } from "@/components/JobWatch";

export const dynamic = "force-dynamic";

const SECTIONS = ["connections", "ai", "data", "content", "affiliates", "media", "automations", "jobs", "backup", "log"];

export default async function SystemPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const sd = await systemDetailsOn();
  const brandId = selectedBrandId();
  const ints = listIntegrations();
  const mcps = listMcpServers();
  const counts = jobCounts();
  const stateFilter = JOB_STATES.includes(sp.state as never) ? (sp.state as (typeof JOB_STATES)[number]) : undefined;
  const jobs = listJobs({ states: stateFilter ? [stateFilter] : undefined, limit: 60 });
  const w = workerStatus();
  const budget = budgetStatus(brandId);
  const recurring = activePolicy("recurring_publication", brandId);
  const paused = isSystemPaused();
  const pausedTypes = pausedJobTypes();
  const log = listAudit({ limit: Number(sp.log) || 60, level: sp.level || undefined });
  const selJob = sp.job ? (() => { try { return getJob(sp.job!); } catch { return null; } })() : null;
  const lastBackup = getSetting<string | null>("last_backup_at", null);

  return (
    <main className="page">
      <div className="between" style={{ alignItems: "flex-end" }}>
        <div>
          <h1>System</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            {sd ? "System details is on — implementation and verification columns are visible. It changes nothing about permissions or behaviour." : "Turn on System details in the header to see implementation and verification status."}
          </p>
        </div>
        <ActionForm op={paused ? "resume_all" : "pause_all"}>
          <Submit variant={paused ? "p" : "s"}>{paused ? "Resume automation" : "Pause all automation"}</Submit>
        </ActionForm>
      </div>

      <div className="sys-grid">
        <nav aria-label="System sections" className="subnav">
          {SECTIONS.map((s) => <a key={s} href={`#${s}`}>{s.toUpperCase()}</a>)}
        </nav>

        <div className="stack-lg">
          <section id="connections" className="card">
            <div className="between pad" style={{ paddingBottom: 12 }}>
              <h2 className="lbl">External connections · {ints.filter((i) => i.def.external && i.state === "CONNECTED").length} of {ints.filter((i) => i.def.external).length}</h2>
              <span className="small muted">CONNECTED requires a passing live test. A saved key is not proof. Secrets live in .env.local, never in the database.</span>
            </div>
            <div className="table-scroll">
              <table className="t">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: 20 }}>Capability</th><th>Provider</th><th>Auth · scopes</th><th>State</th><th>Last test / success</th>
                    {sd ? <th className="sd">Acceptance check</th> : null}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ints.map((i, n) => {
                    const firstOfSection = ints.findIndex((x) => x.section === i.section) === n;
                    const err = parseJson<{ message?: string; at?: string } | null>(i.last_error_json, null);
                    const caps = parseJson<string[]>(i.verified_capabilities_json, []);
                    return (
                      <tr key={i.id} id={firstOfSection ? i.section.toLowerCase() : undefined}>
                        <td style={{ paddingLeft: 20 }}><div style={{ fontWeight: 500 }}>{i.def.section} · {i.capability}</div><div className="mono small muted">{i.id}</div></td>
                        <td>{i.provider}</td>
                        <td className="small">{i.auth_method}<div className="muted">{i.scopes}</div>{i.def.external ? <div className="mono muted" style={{ fontSize: 11 }}>env: {i.def.secrets.concat(i.def.config).join(", ")}</div> : null}</td>
                        <td>
                          <Chip v={i.state} />
                          {i.missing.length && i.def.external ? <div className="small muted" style={{ marginTop: 4 }}>Missing: {i.missing.join(", ")}</div> : null}
                          {caps.length ? <div className="small muted" style={{ marginTop: 4 }}>Verified: {caps.join("; ")}</div> : null}
                        </td>
                        <td className="small mono">{i.last_test_at ? `${i.last_test_at.slice(0, 16).replace("T", " ")} ${i.last_test_result === "FAILED" ? "✗" : "✓"}` : "Never"}<div className="muted">{i.last_success_at ? `ok ${i.last_success_at.slice(0, 16).replace("T", " ")}` : "no success yet"}</div></td>
                        {sd ? <td className="sd small">{i.def.acceptance}<div className="muted">Limits: {i.limits_text || "—"}</div></td> : null}
                        <td style={{ minWidth: 200 }}>
                          {i.def.external ? (
                            <div className="row" style={{ gap: 6 }}>
                              {i.state === "PAUSED" || i.state === "DISABLED" ? (
                                <ActionForm op="int_resume" hidden={{ id: i.id }}><Submit small>Resume</Submit></ActionForm>
                              ) : (
                                <>
                                  <ActionForm op="int_connect" hidden={{ id: i.id }}><Submit small variant={i.state === "CONNECTED" ? "s" : "p"}>{i.state === "NOT_CONNECTED" ? "Connect" : "Reconnect"}</Submit></ActionForm>
                                  <ActionForm op="int_test" hidden={{ id: i.id }}><Submit small disabled={i.state === "NOT_CONNECTED"}>{i.last_test_result === "FAILED" ? "Retry" : "Test"}</Submit></ActionForm>
                                  <ActionForm op="int_pause" hidden={{ id: i.id }}><Submit small disabled={i.state === "NOT_CONNECTED"}>Pause</Submit></ActionForm>
                                  <ActionForm op="int_disable" hidden={{ id: i.id }} confirmText="Disable this integration? Dependent jobs will block."><Submit small>Disable</Submit></ActionForm>
                                </>
                              )}
                              {err ? <details style={{ width: "100%" }}><summary className="small">View error</summary><div className="small msg err" style={{ marginTop: 4 }}>{err.message}{err.at ? ` (${err.at.slice(0, 16)})` : ""}</div></details> : null}
                            </div>
                          ) : (
                            <span className="small muted">{i.state === "LOCAL" ? "Built in — use BRAND › Reporting import" : "Not needed for articles"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pad stack" style={{ borderTop: "1px solid var(--line)" }}>
              <div className="between">
                <h3 className="lbl">MCP servers · {mcps.length}</h3>
                <span className="small muted">This app's own registry. Connectors inside chat apps are not available here. Tools are unusable until allowlisted.</span>
              </div>
              {mcps.map((m) => {
                const tools = parseJson<{ name: string; description: string }[]>(m.tools_json, []);
                const al = parseJson<Record<string, number>>(m.allowlist_json, {});
                return (
                  <details key={m.id} className="card" style={{ padding: 12 }}>
                    <summary className="row"><strong>{m.name}</strong><Chip v={m.state} /><span className="small muted mono">{m.transport} · {m.url ?? m.command}</span></summary>
                    <div className="stack" style={{ marginTop: 10 }}>
                      <div className="row">
                        <ActionForm op="mcp_discover" hidden={{ id: m.id }}><Submit small variant="p">Discover tools</Submit></ActionForm>
                        <ActionForm op="mcp_state" hidden={{ id: m.id, state: m.state === "PAUSED" ? "CONFIGURING" : "PAUSED" }}><Submit small>{m.state === "PAUSED" ? "Resume" : "Pause"}</Submit></ActionForm>
                        <ActionForm op="mcp_state" hidden={{ id: m.id, state: "DISABLED" }}><Submit small>Disable</Submit></ActionForm>
                      </div>
                      {m.last_error ? <div className="msg err small">{m.last_error}</div> : null}
                      {tools.length ? (
                        <table className="t">
                          <thead><tr><th>Tool</th><th>Allowlist level</th></tr></thead>
                          <tbody>
                            {tools.map((t) => (
                              <tr key={t.name}>
                                <td className="wrap"><span className="mono">{t.name}</span><div className="small muted">{t.description}</div></td>
                                <td>
                                  <ActionForm op="mcp_allow" hidden={{ id: m.id, tool: t.name }} className="row">
                                    <select name="level" defaultValue={al[t.name] ?? ""} aria-label={`Allowlist ${t.name}`} style={{ width: "auto" }}>
                                      <option value="">Not allowed</option><option value="0">L0 observe</option><option value="1">L1 prepare</option><option value="2">L2 reversible</option><option value="3">L3 commercial</option>
                                    </select>
                                    <Submit small>Save</Submit>
                                  </ActionForm>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : <p className="small muted">No tools discovered yet.</p>}
                    </div>
                  </details>
                );
              })}
              <details>
                <summary className="btn">Add MCP server</summary>
                <ActionForm op="mcp_add" className="stack" style={{ marginTop: 10 }} resetOnSuccess>
                  <div className="grid-2e" style={{ gap: 8 }}>
                    <label className="field">Name<input type="text" name="name" required /></label>
                    <label className="field">Transport<select name="transport"><option value="http">Streamable HTTP</option><option value="stdio">stdio (local command)</option></select></label>
                    <label className="field">URL (http)<input type="url" name="url" placeholder="https://…/mcp" /></label>
                    <label className="field">Authorization header env var (http)<input type="text" name="authHeaderRef" placeholder="e.g. MY_MCP_AUTH" /></label>
                    <label className="field">Command (stdio)<input type="text" name="command" placeholder="npx" /></label>
                    <label className="field">Arguments (stdio)<input type="text" name="args" placeholder="-y some-mcp-server" /></label>
                  </div>
                  <label className="field">Env var names passed to stdio server (comma-separated names, not values)<input type="text" name="envRefs" /></label>
                  <Submit>Register</Submit>
                </ActionForm>
              </details>
            </div>
          </section>

          <section id="automations" className="grid-3">
            <div className="card pad stack">
              <h2 className="lbl">Budget & limits</h2>
              <div className="row"><span style={{ fontWeight: 500 }}>AI / external spend cap</span>{budget.cap ? <Chip v="ACTIVE" label={`${budget.cap.amount.toFixed(2)} ${budget.cap.currency}/MONTH`} /> : <Chip v="BLOCKED" label="NOT SET" />}</div>
              <p className="small" style={{ color: "var(--ink-2)" }}>
                {budget.cap ? `Spent this month: ${budget.spent.toFixed(2)} ${budget.cap.currency}${budget.spentIncludesEstimates ? " (includes estimates)" : ""}. Remaining ${budget.remaining?.toFixed(2)}.` : "Paid jobs stay BLOCKED until a cap is set."} Token prices must also be set in .env.local so spend can be checked. Max attempts per job: 1–3 by type.
              </p>
              <ActionForm op="budget_set" className="row">
                <input type="number" name="amount" min="1" step="1" placeholder="Amount" aria-label="Cap amount" required style={{ width: 110 }} defaultValue={budget.cap?.amount} />
                <input type="text" name="currency" maxLength={3} aria-label="Currency" style={{ width: 70 }} defaultValue={budget.cap?.currency ?? "USD"} />
                <Submit small variant="p">Set cap</Submit>
              </ActionForm>
            </div>
            <div className="card pad stack">
              <h2 className="lbl">Permissions & policy</h2>
              <div className="row"><Chip v="PENDING" label="DEFAULT LEVELS 1–2" />{recurring ? <Chip v="ACTIVE" label={`RECURRING v${recurring.version}`} /> : <Chip v="x" label="NO RECURRING POLICY" cls="c-off" />}</div>
              <p className="small" style={{ color: "var(--ink-2)" }}>L0 observe · L1 prepare · L2 reversible · L3 commercial (policy-bound) · L4 human only. The first publication always needs your explicit PUBLISH. A recurring policy lets the worker publish further READY items that each carry their own approval.</p>
              {recurring ? (
                <ActionForm op="recurring_revoke"><Submit small>Revoke recurring publication</Submit></ActionForm>
              ) : (
                <ActionForm op="recurring_set" className="row">
                  <input type="number" name="maxPerWeek" min="1" max="50" defaultValue={2} aria-label="Max per week" style={{ width: 80 }} />
                  <Submit small>Approve recurring policy</Submit>
                </ActionForm>
              )}
              <ActionForm op="human_review_route" hidden={{ allow: allowHumanEditorialReview() ? "0" : "1" }} className="row">
                <span className="small">Human editorial review route: <strong>{allowHumanEditorialReview() ? "allowed" : "disabled"}</strong></span>
                <Submit small>{allowHumanEditorialReview() ? "Disable" : "Allow"}</Submit>
              </ActionForm>
            </div>
            <div className="card pad stack">
              <h2 className="lbl">Workflows</h2>
              <p className="small muted">Pause individual job types. Paused work stays queued or blocked; nothing is lost.</p>
              {Object.values(JOB_TYPES).map((t) => (
                <ActionForm key={t.type} op={pausedTypes.includes(t.type) ? "resume_type" : "pause_type"} hidden={{ jobType: t.type }} className="between">
                  <span className="small">{t.label} <span className="muted mono">L{t.level}</span></span>
                  <Submit small>{pausedTypes.includes(t.type) ? "Resume" : "Pause"}</Submit>
                </ActionForm>
              ))}
            </div>
          </section>

          <section id="jobs" className="card">
            <div className="between pad" style={{ paddingBottom: 10 }}>
              <h2 className="lbl">Jobs</h2>
              <span className="row small mono"><span className="dot" style={{ background: w.alive ? "#2e9e66" : "#e5a54b" }} />{w.alive ? `${w.workerId} · heartbeat ${w.lastBeat?.slice(11, 19)} UTC` : `Worker not running${w.lastBeat ? ` (last heartbeat ${w.lastBeat.slice(0, 19).replace("T", " ")} UTC)` : ""} — jobs wait until it starts (npm start)`}</span>
            </div>
            <div className="row" style={{ padding: "0 20px 12px", gap: 6 }}>
              <a href="/system#jobs" className={`chip ${!stateFilter ? "c-dark" : "c-off"}`} style={{ textDecoration: "none" }}>ALL</a>
              {JOB_STATES.map((s) => (
                <a key={s} href={`/system?state=${s}#jobs`} className={`chip ${stateFilter === s ? "c-dark" : counts[s] && ["BLOCKED", "FAILED"].includes(s) ? "c-block" : counts[s] && s === "NEEDS_ATTENTION" ? "c-warn" : "c-off"}`} style={{ textDecoration: "none" }}>{s.replace("_", " ")} {counts[s]}</a>
              ))}
            </div>
            {selJob ? (
              <div className="pad" style={{ borderTop: "1px solid var(--line)", background: "#faf9f5" }}>
                <div className="between"><h3 className="lbl">Job {selJob.id}</h3><a href="/system#jobs" className="small">Close</a></div>
                <JobWatch jobId={selJob.id} />
                <dl className="kv" style={{ marginTop: 10 }}>
                  <dt>Type</dt><dd>{selJob.type} · L{selJob.permission_level} · actor {selJob.actor}</dd>
                  <dt>Target</dt><dd className="mono">{selJob.content_id ?? selJob.brand_id ?? "—"} {selJob.revision_id ? `@ ${selJob.revision_id}` : ""}</dd>
                  <dt>Attempts</dt><dd>{selJob.attempts} / {selJob.max_attempts} · side effect {selJob.side_effect_state}</dd>
                  <dt>Idempotency</dt><dd className="mono small">{selJob.idempotency_key}</dd>
                  <dt>Correlation</dt><dd className="mono small">{selJob.correlation_id}</dd>
                  {selJob.approval_id ? (<><dt>Approval</dt><dd className="mono small">{selJob.approval_id}</dd></>) : null}
                  {selJob.usage_json ? (<><dt>Usage</dt><dd className="mono small">{selJob.usage_json}{selJob.cost_estimate != null ? ` · est. ${selJob.cost_estimate.toFixed(4)}` : ""}</dd></>) : null}
                  {selJob.output_json ? (<><dt>Output</dt><dd className="mono small pre">{selJob.output_json.slice(0, 2000)}</dd></>) : null}
                </dl>
                <div className="logbox" style={{ marginTop: 10 }}>{jobEvents(selJob.id).map((e) => `${e.at}  ${e.state.padEnd(15)} ${e.message}`).join("\n") || "No events."}</div>
              </div>
            ) : null}
            <div className="table-scroll">
              <table className="t">
                <thead><tr><th style={{ paddingLeft: 20 }}>Job</th><th>Type</th><th>Target</th><th>State</th><th>Tries</th><th>Dependency / error</th><th>Actions</th></tr></thead>
                <tbody>
                  {jobs.length === 0 ? <tr><td colSpan={7} style={{ paddingLeft: 20 }} className="muted small">No jobs{stateFilter ? ` in ${stateFilter}` : ""}.</td></tr> : null}
                  {jobs.map((j) => {
                    const blocked = parseJson<string[]>(j.blocked_reason_json, []);
                    const err = parseJson<{ message?: string } | null>(j.error_json, null);
                    return (
                      <tr key={j.id}>
                        <td className="mono small wrap" style={{ paddingLeft: 20 }}><a href={`/system?job=${j.id}#jobs`}>{j.id}</a>{j.legacy ? <div><Chip v="UNVERIFIED" label="LEGACY" /></div> : null}</td>
                        <td className="small">{JOB_TYPES[j.type]?.label ?? j.type}</td>
                        <td className="mono small wrap">{j.content_id ?? j.brand_id ?? "—"}</td>
                        <td><Chip v={j.state} /></td>
                        <td className="mono small">{j.attempts} / {j.max_attempts}</td>
                        <td className="small wrap">{j.state === "BLOCKED" ? blocked.join(" ") : err?.message ?? j.progress_text}</td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            {["QUEUED", "BLOCKED", "RETRYING", "NEEDS_ATTENTION"].includes(j.state) || (j.state === "RUNNING" && !JOB_TYPES[j.type]?.sideEffect) ? (
                              <ActionForm op="job_cancel" hidden={{ id: j.id }} showJob={false}><Submit small>Cancel</Submit></ActionForm>
                            ) : null}
                            {["FAILED", "NEEDS_ATTENTION", "CANCELLED"].includes(j.state) ? (
                              <ActionForm op="job_retry" hidden={{ id: j.id }} showJob={false}><Submit small>Retry</Submit></ActionForm>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section id="backup" className="card pad stack">
            <h2 className="lbl">Data & backups</h2>
            <div className="mono small" style={{ lineHeight: 1.7, color: "var(--ink-2)" }}>
              db: {dbPath()} · schema v{currentSchemaVersion()}<br />
              assets: {assetsDir()}<br />
              backups: {backupsDir()} · last backup: {lastBackup ? lastBackup.slice(0, 16).replace("T", " ") + " UTC" : "never"}
            </div>
            <div className="row">
              <ActionForm op="backup_now"><Submit variant="p">Back up now</Submit></ActionForm>
              <ActionForm op="export_now"><Submit>Export to folder</Submit></ActionForm>
              <a className="btn" href="/api/export">Download JSON</a>
            </div>
            <ActionForm op="import_bundle" className="stack">
              <p className="small muted">Import an omos.export.v1 data.json. Default is a dry run. Existing IDs are never overwritten. “As legacy” imports prior approvals, QA and job results as unverified history.</p>
              <div className="row">
                <input type="file" name="bundle" accept="application/json,.json" required aria-label="Export file" />
                <label className="row small"><input type="checkbox" name="apply" value="1" /> apply</label>
                <label className="row small"><input type="checkbox" name="legacy" value="1" defaultChecked /> as legacy (unverified)</label>
                <Submit>Import</Submit>
              </div>
            </ActionForm>
            <p className="small muted">Restore: stop the app, then run <span className="mono">npm run restore -- &lt;backup folder&gt;</span> (see README).</p>
            <details>
              <summary className="small">Change operator password</summary>
              <ActionForm op="password_change" className="row" style={{ marginTop: 8 }}>
                <input type="password" name="current" placeholder="Current" aria-label="Current password" required style={{ width: 180 }} />
                <input type="password" name="next" placeholder="New (12+ chars)" aria-label="New password" required minLength={12} style={{ width: 200 }} />
                <Submit small>Change</Submit>
              </ActionForm>
            </details>
          </section>

          {sd ? (
            <section className="card">
              <div className="between pad" style={{ paddingBottom: 10 }}>
                <h2 className="lbl">Implementation status</h2>
                <span className="small muted">LIVE_VERIFIED appears only after a recorded successful live call. No percentages are estimated.</span>
              </div>
              <div className="table-scroll">
                <table className="t">
                  <thead><tr><th style={{ paddingLeft: 20 }}>Capability</th><th className="sd">Implementation</th><th className="sd">Verification</th><th>Evidence</th><th>Dependency / blocking</th><th>Next task</th><th>Definition of done</th></tr></thead>
                  <tbody>
                    {IMPLEMENTATION.map((e) => (
                      <tr key={e.key}>
                        <td style={{ paddingLeft: 20 }}><div style={{ fontWeight: 500 }}>{e.capability}</div><div className="small muted">{e.area}</div></td>
                        <td className="sd"><Chip v={e.impl === "VERIFIED" ? "IMPLEMENTED" : e.impl} label={e.impl} /></td>
                        <td className="sd"><Chip v={effectiveVerification(e) === "NOT_VERIFIED" ? "x" : effectiveVerification(e)} label={effectiveVerification(e)} /></td>
                        <td className="small wrap">{e.evidence}</td>
                        <td className="small">{e.dependency}</td>
                        <td className="small">{e.next}</td>
                        <td className="small">{e.done}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section id="log" className="card pad stack">
            <div className="between">
              <h2 className="lbl">Event log</h2>
              <span className="row small">
                <a href="/system#log">All</a> · <a href="/system?level=WARN#log">Warnings</a> · <a href="/system?level=ERROR#log">Errors</a> · <a href={`/system?log=${(Number(sp.log) || 60) + 100}#log`}>More</a>
              </span>
            </div>
            <p className="small muted">Structured events with correlation IDs. Secrets are redacted at write time.</p>
            <div className="logbox">
              {log.map((l) => `${l.at}  ${l.level.padEnd(5)} ${l.action.padEnd(24)} ${l.summary}${l.correlation_id ? `  corr=${l.correlation_id}` : ""}`).join("\n") || "No events."}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
