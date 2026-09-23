import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/core/db";
import { listPillars } from "@/core/brand";
import { listOffers } from "@/core/commercial";
import {
  approvalState,
  checkTransition,
  getContent,
  getRevision,
  listApprovals,
  listClaims,
  listEvidence,
  listPublications,
  listRevisions,
  publishGaps,
  readiness,
  STAGES,
} from "@/core/content";
import { blockReasons, listJobs } from "@/core/jobs";
import { listQa } from "@/core/qa";
import { CLAIM_TYPES, FACT_STATUSES, INTENTS, RISKS } from "@/core/types";
import { AppError, parseJson } from "@/core/util";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Chip } from "@/components/Chip";

export const dynamic = "force-dynamic";

const TABS = ["research", "script", "commercial", "qa", "performance"] as const;

function Gate({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return <span className="small muted gate" style={{ lineHeight: 1.4 }}>{reasons.join(" ")}</span>;
}

export default async function ContentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  let item;
  try {
    item = getContent(id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as (typeof TABS)[number]) : item.stage === "IDEA" || item.stage === "RESEARCH" ? "research" : "script";
  const rev = getRevision(item.current_revision_id);
  const revisions = listRevisions(id);
  const compare = sp.compare ? revisions.find((r) => r.id === sp.compare) : undefined;
  const evidence = listEvidence(id);
  const claims = listClaims(id);
  const approvals = listApprovals("content", id);
  const pubs = listPublications(id);
  const qa = listQa(id);
  const rd = readiness(item);
  const appr = approvalState(item);
  const pillars = listPillars(item.brand_id);
  const offers = listOffers(item.brand_id);
  const jobs = listJobs({ contentId: id, limit: 20 });
  const obs = getDb().prepare("SELECT * FROM performance_observations WHERE content_id = ? ORDER BY period_start DESC LIMIT 60").all(id) as {
    id: string; source: string; metric: string; value: number; currency: string | null; period_start: string; period_end: string; observed_at: string;
  }[];
  const pre = (type: string) => blockReasons({ type, brand_id: item.brand_id, approval_id: null });
  const nextStage = STAGES[STAGES.indexOf(item.stage) + 1];
  const retired = !!item.retired_at;

  const readyCard = (label: string, r: { ok: boolean; state: string; reasons: string[] }) => (
    <div className="card stack" style={{ padding: "14px 16px", gap: 8 }}>
      <div className="lbl">{label}</div>
      <div><Chip v={r.ok ? "CLEARED" : r.state} label={r.ok ? (r.state === "CLEARED" ? "CLEARED" : r.state) : r.state} cls={r.ok ? "c-ok" : r.state === "NOT_CONNECTED" || r.state === "NO_DATA" || r.state === "NOT_PUBLISHED" ? "c-off" : r.state === "QA_NOT_RUN" ? "c-warn" : "c-block"} /></div>
      <div className="small" style={{ color: "var(--ink-2)" }}>{r.reasons.join(" ") || "All checks satisfied."}</div>
    </div>
  );

  return (
    <main className="page">
      <nav aria-label="Breadcrumb" className="row small muted">
        <Link href="/pipeline">Pipeline</Link>
        <span aria-hidden="true">/</span>
        <span className="mono">{id}</span>
      </nav>

      <div className="between" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 10 }}>
          <h1>{item.title}</h1>
          <div className="row" style={{ gap: 6 }}>
            <Chip v="STAGE" label={`STAGE ${item.stage}`} cls="c-dark" />
            <Chip v="p" label={item.pillar_id ? pillars.find((p) => p.id === item.pillar_id)?.name ?? "—" : "NO PILLAR"} cls="c-off" />
            <Chip v="i" label={`INTENT ${item.buyer_intent ?? "—"}`} cls="c-off" />
            <Chip v={item.risk} label={`RISK ${item.risk}`} />
            <Chip v={appr} label={`APPROVAL ${appr}`} />
            <Chip v="r" label={`REV ${rev.number}`} cls="c-off" />
            {item.research_status !== "RESEARCHED" ? <Chip v="UNVERIFIED" label={item.research_status} cls="c-off" /> : null}
            {item.legacy ? <Chip v="UNVERIFIED" label="LEGACY · UNVERIFIED" /> : null}
            {retired ? <Chip v="r" label="RETIRED" cls="c-off" /> : null}
          </div>
        </div>
        <div className="row">
          <a className="btn" href={`/api/content/${id}/export`}>Export</a>
          {retired ? (
            <ActionForm op="content_restore" hidden={{ id }}><Submit>Restore</Submit></ActionForm>
          ) : (
            <ActionForm op="content_retire" hidden={{ id }} confirmText="Retire this item? It is reversible and keeps all revisions and evidence."><Submit>Retire</Submit></ActionForm>
          )}
        </div>
      </div>

      <div className="grid-4">
        {readyCard("Editorial", rd.editorial)}
        {readyCard("Commercial", rd.commercial)}
        {readyCard("Publication", rd.publication)}
        {readyCard("Measurement", rd.measurement)}
      </div>

      <div className="grid-2">
        <div className="card">
          <nav className="tabs" aria-label="Content sections">
            {TABS.map((t) => (
              <Link key={t} href={`/pipeline/${id}?tab=${t}`} aria-current={tab === t ? "page" : undefined}>{t.toUpperCase()}</Link>
            ))}
          </nav>
          <div className="stack pad" style={{ gap: 18 }}>
            {tab === "research" ? (
              <>
                <div className="between">
                  <h2 className="lbl">Research notes · revision {rev.number}</h2>
                  <ActionForm op="run" hidden={{ jobType: "RESEARCH", contentId: id }} className="row">
                    <Submit variant="p" disabled={retired}>Generate research</Submit>
                    <Gate reasons={pre("RESEARCH")} />
                  </ActionForm>
                </div>
                <ActionForm op="content_save" hidden={{ id }} className="stack">
                  <textarea name="researchNotes" defaultValue={rev.research_notes} aria-label="Research notes" placeholder="No research yet. Generate it, or write notes and attach sources below." style={{ minHeight: 220 }} />
                  <input type="hidden" name="changeNote" value="Research notes edited" />
                  <div className="row"><Submit>Save notes (new revision)</Submit></div>
                </ActionForm>

                <h2 className="lbl">Evidence · {evidence.length}</h2>
                {evidence.length === 0 ? <p className="small muted">No evidence attached.</p> : null}
                <div className="table-scroll">
                  <table className="t">
                    <thead><tr><th>Source</th><th>Kind</th><th>Checked</th><th>Status</th></tr></thead>
                    <tbody>
                      {evidence.map((e) => (
                        <tr key={e.id}>
                          <td className="wrap">
                            <div style={{ fontWeight: 500 }}>{e.url ? <a href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a> : e.title}</div>
                            <div className="mono small muted">{e.id}{e.file_path ? <> · <a href={`/api/evidence/${e.id}/file`}>file</a></> : null}</div>
                            {e.excerpt ? <details><summary className="small">Excerpt</summary><div className="small pre" style={{ maxHeight: 240, overflow: "auto" }}>{e.excerpt}</div></details> : null}
                          </td>
                          <td className="small">{e.kind}</td>
                          <td className="small mono">{e.checked_at?.slice(0, 10) ?? "—"}</td>
                          <td><Chip v={e.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details>
                  <summary className="btn">Attach evidence</summary>
                  <ActionForm op="evidence_add" hidden={{ contentId: id }} className="stack" resetOnSuccess style={{ marginTop: 12 }}>
                    <div className="grid-2e" style={{ gap: 8 }}>
                      <label className="field">Title<input type="text" name="title" required /></label>
                      <label className="field">Kind
                        <select name="kind" defaultValue="WEB_SOURCE"><option value="WEB_SOURCE">Web source</option><option value="DOCUMENT">Document</option><option value="MANUAL_NOTE">Manual note</option></select>
                      </label>
                      <label className="field">URL<input type="url" name="url" placeholder="https://" /></label>
                      <label className="field">Checked on<input type="date" name="checkedAt" /></label>
                    </div>
                    <label className="field">Excerpt / what the source says<textarea name="excerpt" style={{ minHeight: 80 }} /></label>
                    <label className="field">File (optional, ≤25 MB)<input type="file" name="file" /></label>
                    <Submit>Attach</Submit>
                  </ActionForm>
                </details>
                <details>
                  <summary className="btn">Import from Google Drive</summary>
                  <ActionForm op="drive_import" hidden={{ contentId: id }} className="stack" style={{ marginTop: 12 }}>
                    <label className="field">Drive file link or ID<input type="text" name="fileRef" required /></label>
                    <div className="row"><Submit>Import</Submit><Gate reasons={pre("DRIVE_IMPORT")} /></div>
                    <p className="small muted">Optional. Local file attachment above works without Google Drive.</p>
                  </ActionForm>
                </details>
              </>
            ) : null}

            {tab === "script" ? (
              <>
                <div className="between">
                  <span className="small muted">Revision {rev.number} · {rev.created_at.slice(0, 16).replace("T", " ")} UTC · author {rev.author}{rev.change_note ? ` · ${rev.change_note}` : ""}</span>
                  <ActionForm op="run" hidden={{ jobType: "SCRIPT", contentId: id }} className="row">
                    <Submit variant="p" disabled={retired}>Generate script</Submit>
                    <Gate reasons={pre("SCRIPT")} />
                  </ActionForm>
                </div>
                {compare ? (
                  <div className="grid-2e" style={{ gap: 12 }}>
                    <div className="stack"><div className="lbl">Revision {compare.number}</div><div className="card pad small pre" style={{ background: "#faf9f5" }}>{compare.title}{"\n\n"}{compare.body || "(empty)"}</div></div>
                    <div className="stack"><div className="lbl">Revision {rev.number} (current)</div><div className="card pad small pre" style={{ background: "#faf9f5" }}>{rev.title}{"\n\n"}{rev.body || "(empty)"}</div></div>
                  </div>
                ) : null}
                <ActionForm op="content_save" hidden={{ id }} className="stack">
                  <label className="field">Title<input type="text" name="title" defaultValue={rev.title} required /></label>
                  <label className="field">Article (Markdown)<textarea className="script" name="body" defaultValue={rev.body} placeholder="No script yet." /></label>
                  <label className="field">Change note<input type="text" name="changeNote" placeholder="What changed" /></label>
                  <div className="row"><Submit variant="p">Save as revision {rev.number + 1}</Submit><span className="small muted">Saving invalidates approvals bound to revision {rev.number}.</span></div>
                </ActionForm>

                <h2 className="lbl">Claims · {claims.length}</h2>
                <p className="small muted">Unresolved SAFETY, ELECTRICAL, COMPATIBILITY, AIRLINE, MANUFACTURER or MEDICAL claims block this item. VERIFIED requires cited evidence with a URL and checked date.</p>
                <div className="table-scroll">
                  <table className="t">
                    <thead><tr><th>Claim</th><th>Type</th><th>Status</th><th>Update</th></tr></thead>
                    <tbody>
                      {claims.map((c) => (
                        <tr key={c.id}>
                          <td className="wrap">{c.text}{c.note ? <div className="small muted">{c.note}</div> : null}</td>
                          <td className="small">{c.claim_type}</td>
                          <td><Chip v={c.status} /></td>
                          <td style={{ minWidth: 260 }}>
                            <ActionForm op="claim_status" hidden={{ claimId: c.id }} className="stack" style={{ gap: 6 }}>
                              <select name="status" defaultValue={c.status} aria-label="Claim status">{FACT_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
                              <select name="evidenceId" defaultValue={c.evidence_id ?? ""} aria-label="Supporting evidence">
                                <option value="">No evidence</option>
                                {evidence.map((e) => <option key={e.id} value={e.id}>{e.title.slice(0, 60)}</option>)}
                              </select>
                              <Submit small>Save</Submit>
                            </ActionForm>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ActionForm op="claim_add" hidden={{ id }} className="row" resetOnSuccess>
                  <input type="text" name="text" placeholder="New claim text" aria-label="Claim text" required style={{ flex: "1 1 280px" }} />
                  <select name="claimType" aria-label="Claim type" style={{ width: "auto" }}>{CLAIM_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
                  <Submit>Add claim</Submit>
                </ActionForm>
              </>
            ) : null}

            {tab === "commercial" ? (
              <>
                <ActionForm op="content_meta" hidden={{ id }} className="stack">
                  <div className="grid-2e" style={{ gap: 12 }}>
                    <label className="field">Commercial decision
                      <select name="commercialDecision" defaultValue={item.commercial_decision}>
                        <option value="UNDECIDED">Undecided</option>
                        <option value="OFFER">Target an offer</option>
                        <option value="NO_OFFER">No offer (no affiliate links)</option>
                      </select>
                    </label>
                    <label className="field">Target offer
                      <select name="targetOfferId" defaultValue={item.target_offer_id ?? ""}>
                        <option value="">None</option>
                        {offers.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.offer_status} · link {o.link_status}</option>)}
                      </select>
                    </label>
                    <label className="field">Pillar
                      <select name="pillarId" defaultValue={item.pillar_id ?? ""}><option value="">None</option>{pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                    </label>
                    <label className="field">Content type<input type="text" name="contentType" defaultValue={item.content_type} /></label>
                    <label className="field">Buyer intent
                      <select name="buyerIntent" defaultValue={item.buyer_intent ?? ""}><option value="">Unset</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</select>
                    </label>
                    <label className="field">Risk
                      <select name="risk" defaultValue={item.risk}>{RISKS.map((i) => <option key={i}>{i}</option>)}</select>
                    </label>
                  </div>
                  <div className="row"><Submit variant="p">Save</Submit><span className="small muted">Changing the offer or decision invalidates approvals bound to the old configuration.</span></div>
                </ActionForm>
                <div className="msg note small">{rd.commercial.ok ? "Commercially cleared." : `Commercial blockers: ${rd.commercial.reasons.join(" ")}`}</div>
                {offers.length === 0 ? <p className="small muted">No offers exist for this brand. Add programs and offers in <Link href="/brand#monetization">BRAND › Monetization</Link>.</p> : null}
              </>
            ) : null}

            {tab === "qa" ? (
              <>
                <div className="row">
                  <ActionForm op="content_qa" hidden={{ id }}><Submit variant="p" disabled={retired}>Run QA (deterministic)</Submit></ActionForm>
                  <ActionForm op="run" hidden={{ jobType: "QA_EDITORIAL", contentId: id }} className="row">
                    <Submit disabled={retired}>AI editorial review</Submit>
                    <Gate reasons={pre("QA_EDITORIAL")} />
                  </ActionForm>
                </div>
                <p className="small muted">Deterministic QA checks structure, disclosures, restricted phrases, evidence and claim status. It does not check facts or medical accuracy — that needs AI editorial review or a recorded human review.</p>
                {qa.length === 0 ? <p className="small muted">No QA reports yet.</p> : null}
                {qa.map((q) => {
                  const f = parseJson<{ check: string; severity: string; message: string }[]>(q.findings_json, []);
                  const rn = revisions.find((r) => r.id === q.revision_id)?.number;
                  return (
                    <details key={q.id} open={q.revision_id === rev.id && q === qa.find((x) => x.kind === q.kind)} className="card" style={{ padding: 12 }}>
                      <summary className="row">
                        <Chip v={q.result} />
                        <strong>{q.kind.replace("_", " ")}</strong>
                        <span className="small muted">rev {rn} {q.revision_id === rev.id ? "(current)" : "(older revision)"} · {q.reviewer} · {q.created_at.slice(0, 16).replace("T", " ")} UTC</span>
                      </summary>
                      <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                        {f.filter((x) => x.severity !== "PASS").map((x, i) => <li key={i} className="small"><Chip v={x.severity} /> {x.check}: {x.message}</li>)}
                        {f.every((x) => x.severity === "PASS") ? <li className="small muted">All checks passed.</li> : null}
                      </ul>
                    </details>
                  );
                })}
                <details>
                  <summary className="btn">Record human editorial review</summary>
                  <ActionForm op="content_human_review" hidden={{ id }} className="stack" style={{ marginTop: 12 }}>
                    <p className="small muted">A recorded human review of revision {rev.number} can satisfy editorial review in place of AI. Describe what you checked.</p>
                    <label className="field">Result<select name="result" defaultValue="PASS"><option>PASS</option><option>FAIL</option></select></label>
                    <label className="field">Notes<textarea name="notes" required minLength={10} style={{ minHeight: 80 }} /></label>
                    <Submit>Record review</Submit>
                  </ActionForm>
                </details>
              </>
            ) : null}

            {tab === "performance" ? (
              <>
                <h2 className="lbl">Publications</h2>
                {pubs.length === 0 ? <p className="small muted">Not published. PUBLISHED requires a provider receipt or evidence-backed manual publication.</p> : null}
                {pubs.map((p) => (
                  <div key={p.id} className="row small">
                    <Chip v={p.status} />
                    {p.remote_url ? <a href={p.remote_url} target="_blank" rel="noreferrer noopener">{p.remote_url}</a> : null}
                    <span className="mono muted">{p.id} · remote {p.remote_id ?? "—"} · {p.created_at.slice(0, 10)}</span>
                  </div>
                ))}
                {item.stage === "READY" ? (
                  <details>
                    <summary className="btn">Record manual publication</summary>
                    <ActionForm op="content_manual_publish" hidden={{ id }} className="stack" style={{ marginTop: 12 }}>
                      <p className="small muted">Use this only after the approved revision is live. Evidence is stored and audited.</p>
                      <label className="field">Live URL<input type="url" name="url" required /></label>
                      <label className="field">How you confirmed it is live<textarea name="proofNote" style={{ minHeight: 70 }} /></label>
                      <label className="field">Screenshot (optional)<input type="file" name="file" accept="image/*,application/pdf" /></label>
                      <Submit variant="p">Record publication</Submit>
                    </ActionForm>
                  </details>
                ) : null}
                <h2 className="lbl">Observations · {obs.length}</h2>
                {obs.length === 0 ? <p className="small muted">{rd.measurement.reasons.join(" ") || "No data yet."}</p> : (
                  <div className="table-scroll">
                    <table className="t">
                      <thead><tr><th>Period</th><th>Metric</th><th>Value</th><th>Source</th><th>Ingested</th></tr></thead>
                      <tbody>{obs.map((o) => <tr key={o.id}><td className="mono small">{o.period_start.slice(0, 10)} → {o.period_end.slice(0, 10)}</td><td>{o.metric}</td><td>{o.value}{o.currency ? ` ${o.currency}` : ""}</td><td className="small">{o.source}</td><td className="mono small">{o.observed_at.slice(0, 16).replace("T", " ")}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>

        <div className="stack-lg">
          <section className="card pad stack" style={{ gap: 4 }}>
            <h2 className="lbl" style={{ marginBottom: 8 }}>Workflow actions</h2>
            {[
              { label: "Generate research", node: <ActionForm op="run" hidden={{ jobType: "RESEARCH", contentId: id }}><Submit small disabled={retired}>Generate research</Submit></ActionForm>, note: pre("RESEARCH") },
              { label: "Generate script", node: <ActionForm op="run" hidden={{ jobType: "SCRIPT", contentId: id }}><Submit small disabled={retired}>Generate script</Submit></ActionForm>, note: pre("SCRIPT") },
              { label: "Run QA", node: <ActionForm op="content_qa" hidden={{ id }}><Submit small disabled={retired}>Run QA</Submit></ActionForm>, note: ["Deterministic checks run now, locally."] },
              {
                label: "Approve",
                node: (
                  <ActionForm op="content_approve" hidden={{ id, revisionId: rev.id }} className="stack" style={{ gap: 6 }}>
                    <input type="text" name="note" placeholder="Approval note (optional)" aria-label="Approval note" />
                    <Submit small variant="p" disabled={item.stage !== "APPROVAL" || !rd.editorial.ok}>Approve rev {rev.number}</Submit>
                  </ActionForm>
                ),
                note: item.stage !== "APPROVAL" ? [`Approval happens in APPROVAL (item is ${item.stage}).`] : rd.editorial.reasons,
              },
              {
                label: "Reject",
                node: (
                  <ActionForm op="content_reject" hidden={{ id }} className="stack" style={{ gap: 6 }}>
                    <input type="text" name="note" placeholder="Reason" aria-label="Rejection reason" />
                    <Submit small disabled={!["APPROVAL", "READY"].includes(item.stage)}>Reject</Submit>
                  </ActionForm>
                ),
                note: [],
              },
              {
                label: "Return for revision",
                node: (
                  <ActionForm op="content_return" hidden={{ id }} className="stack" style={{ gap: 6 }}>
                    <input type="text" name="note" placeholder="What needs revising" aria-label="Revision note" />
                    <Submit small disabled={!["QA", "APPROVAL", "READY"].includes(item.stage)}>Return for revision</Submit>
                  </ActionForm>
                ),
                note: [],
              },
              { label: "Advance", node: nextStage && nextStage !== "PUBLISHED" ? <ActionForm op="content_move" hidden={{ id, stage: nextStage }}><Submit small disabled={retired || checkTransition(item, nextStage).length > 0}>{nextStage === "READY" ? "Mark ready" : `Move to ${nextStage}`}</Submit></ActionForm> : <span className="small muted">—</span>, note: nextStage && nextStage !== "PUBLISHED" ? checkTransition(item, nextStage) : [] },
              { label: "Publish", node: <ActionForm op="content_publish" hidden={{ id }} confirmText="Publish this approved revision to WordPress now?"><Submit small variant="p" disabled={publishGaps(item).length > 0}>Publish</Submit></ActionForm>, note: [...publishGaps(item), ...pre("PUBLISH").filter((r) => !r.includes("approval"))] },
              {
                label: "Fix with AI",
                node: (
                  <ActionForm op="run" hidden={{ jobType: "REVISE", contentId: id }} className="stack" style={{ gap: 6 }}>
                    <input type="text" name="instruction" placeholder="Instruction for the revision" aria-label="Revision instruction" />
                    <Submit small disabled={retired}>Fix with AI</Submit>
                  </ActionForm>
                ),
                note: pre("REVISE"),
              },
            ].map((a) => (
              <div key={a.label} style={{ display: "grid", gridTemplateColumns: "minmax(150px, 180px) minmax(0,1fr)", gap: 12, alignItems: "start", padding: "10px 0", borderTop: "1px solid var(--line-2)" }}>
                <div>{a.node}</div>
                <Gate reasons={a.note.length ? a.note : ["Available."]} />
              </div>
            ))}
          </section>

          <section className="card pad stack" style={{ gap: 4 }}>
            <h2 className="lbl" style={{ marginBottom: 8 }}>Revision history</h2>
            {revisions.map((r) => (
              <div key={r.id} className="between small" style={{ padding: "8px 0", borderTop: "1px solid var(--line-2)" }}>
                <span><strong>rev {r.number}</strong>{r.id === rev.id ? " · current" : ""} — {r.change_note || "—"}</span>
                <span className="muted">
                  {r.author} · {r.created_at.slice(0, 10)}
                  {r.id !== rev.id ? <> · <Link href={`/pipeline/${id}?tab=script&compare=${r.id}`}>compare</Link></> : null}
                </span>
              </div>
            ))}
          </section>

          <section className="card pad stack" style={{ gap: 8 }}>
            <h2 className="lbl">Approval record</h2>
            {approvals.length === 0 ? <p className="small muted">No approvals recorded.</p> : null}
            {approvals.map((a) => {
              const rn = revisions.find((r) => r.id === a.revision_id)?.number;
              return (
                <div key={a.id} className="small stack" style={{ gap: 2, paddingTop: 8, borderTop: "1px solid var(--line-2)" }}>
                  <div className="row"><Chip v={a.decision} /><Chip v={a.status === "ACTIVE" ? "ACTIVE" : "EXPIRED"} label={a.status} />{a.legacy ? <Chip v="UNVERIFIED" label="LEGACY" /> : null}</div>
                  <span>rev {rn ?? "?"} · {a.destination} · by {a.actor} · {a.created_at.slice(0, 16).replace("T", " ")} UTC</span>
                  {a.note ? <span className="muted">“{a.note}”</span> : null}
                  {a.invalidated_reason ? <span className="muted">Invalidated: {a.invalidated_reason}</span> : null}
                </div>
              );
            })}
          </section>

          <section className="card pad stack" style={{ gap: 6 }}>
            <h2 className="lbl">Jobs for this item</h2>
            {jobs.length === 0 ? <p className="small muted">None.</p> : null}
            {jobs.map((j) => (
              <Link key={j.id} href={`/system?job=${j.id}#jobs`} className="row small" style={{ textDecoration: "none" }}>
                <Chip v={j.state} />
                <span className="mono">{j.id}</span>
                <span className="muted">{j.type}</span>
              </Link>
            ))}
          </section>
        </div>
      </div>
    </main>
  );
}
