import Link from "next/link";
import { activationBlockers, brandSettings, getAvatars, getBrand, listPillars, selectedBrandId } from "@/core/brand";
import { listFacts, listOffers, listPrograms, linkActivationGaps, monetizationSummary, qualificationGaps } from "@/core/commercial";
import { getDb } from "@/core/db";
import { listIntegrations } from "@/core/integrations";
import { blockReasons } from "@/core/jobs";
import { brandMilestones } from "@/core/milestones";
import { CSV_COLUMNS } from "@/core/performance";
import { COMMERCIAL_CRITERIA, FACT_STATUSES, CAP } from "@/core/types";
import { parseJson } from "@/core/util";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Chip } from "@/components/Chip";

export const dynamic = "force-dynamic";

export default async function BrandPage() {
  const brandId = selectedBrandId();
  const b = getBrand(brandId);
  const st = brandSettings(b);
  const pillars = listPillars(brandId);
  const avatars = getAvatars(brandId);
  const programs = listPrograms(brandId);
  const offers = listOffers(brandId);
  const ms = brandMilestones(brandId);
  const money = monetizationSummary(brandId);
  const ints = listIntegrations().filter((i) => i.def.external && i.id !== CAP.DRIVE);
  const connected = ints.filter((i) => i.state === "CONNECTED").length;
  const actBlock = activationBlockers(brandId);
  const execReasons = [...new Set([...blockReasons({ type: "RESEARCH", brand_id: brandId, approval_id: null }), ...blockReasons({ type: "PUBLISH", brand_id: brandId, approval_id: "x" })])];
  const counts = getDb().prepare("SELECT pillar_id, COUNT(*) n, SUM(research_status='RESEARCHED') r FROM content_items WHERE brand_id=? AND retired_at IS NULL GROUP BY pillar_id").all(brandId) as { pillar_id: string | null; n: number; r: number }[];
  const rev = getDb().prepare("SELECT COALESCE(SUM(value),0) v, COUNT(*) n FROM performance_observations WHERE brand_id=? AND metric='revenue' AND currency=?").get(brandId, b.currency) as { v: number; n: number };
  const cost = getDb().prepare("SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM costs WHERE brand_id=? AND currency=?").get(brandId, b.currency) as { v: number; n: number };

  return (
    <main className="page">
      <div className="between" style={{ alignItems: "flex-end" }}>
        <div>
          <h1>{b.name}</h1>
          <p className="mono small muted" style={{ marginTop: 6 }}>{b.id} · market {b.market} · language {b.language} · currency {b.currency}{b.origin_id ? ` · cloned from ${b.origin_id}` : ""}</p>
        </div>
        <div className="row">
          <details style={{ position: "relative" }}>
            <summary className="btn" style={{ listStyle: "none" }}>Clone brand</summary>
            <div className="card pad" style={{ position: "absolute", right: 0, top: 48, zIndex: 20, width: "min(420px, 90vw)", boxShadow: "0 12px 32px rgba(0,0,0,.15)" }}>
              <ActionForm op="brand_clone" className="stack">
                <p className="small muted">Copies configuration, pillars, avatar, IDEA templates and monetization setup with new IDs. Excludes credentials, approvals, publications, performance and pending jobs. The clone starts in DRAFT.</p>
                <label className="field">Name<input type="text" name="name" required /></label>
                <div className="grid-3" style={{ gap: 8 }}>
                  <label className="field">Market<input type="text" name="market" defaultValue={b.market} required /></label>
                  <label className="field">Language<input type="text" name="language" defaultValue={b.language} required /></label>
                  <label className="field">Currency<input type="text" name="currency" defaultValue={b.currency} maxLength={3} required /></label>
                </div>
                <Submit variant="p">Clone</Submit>
              </ActionForm>
            </div>
          </details>
          {b.status === "ACTIVE" ? <ActionForm op="brand_status" hidden={{ status: "PAUSED" }}><Submit>Pause</Submit></ActionForm> : null}
          {b.status !== "ACTIVE" && b.status !== "ARCHIVED" ? (
            <ActionForm op="brand_status" hidden={{ status: "ACTIVE" }}>
              <Submit variant="p" disabled={actBlock.length > 0} title={actBlock.join(" ")}>{actBlock.length ? "Activate · avatar not approved" : "Activate"}</Submit>
            </ActionForm>
          ) : null}
          {b.status !== "ARCHIVED" ? <ActionForm op="brand_status" hidden={{ status: "ARCHIVED" }} confirmText="Archive this brand? Its jobs stop being scheduled."><Submit>Archive</Submit></ActionForm> : <ActionForm op="brand_status" hidden={{ status: "DRAFT" }}><Submit>Unarchive (to DRAFT)</Submit></ActionForm>}
        </div>
      </div>

      <div className="grid-3">
        <div className="card pad stack" style={{ gap: 8 }}>
          <div className="lbl">Activation</div>
          <div className="row"><Chip v={b.status === "ACTIVE" ? "ACTIVE" : "x"} label={b.status} cls={b.status === "ACTIVE" ? "c-ok" : b.status === "PAUSED" ? "c-warn" : "c-off"} /><span className="small">{b.status === "ACTIVE" ? "Activated by you" : actBlock.join(" ") || "Not activated"}</span></div>
        </div>
        <div className="card pad stack" style={{ gap: 8 }}>
          <div className="lbl">Execution readiness</div>
          <div className="row"><Chip v={execReasons.length ? "BLOCKED" : "CLEARED"} /><span className="small">{execReasons.length ? `${execReasons.length} blocker(s)` : "Research-to-publish path is executable"}</span></div>
          {execReasons.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18, color: "var(--ink-2)" }}>{execReasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
        </div>
        <div className="card pad stack" style={{ gap: 8 }}>
          <div className="lbl">Connection health</div>
          <div className="row"><Chip v={connected === ints.length ? "CONNECTED" : "x"} label={`${connected} / ${ints.length} CONNECTED`} cls={connected === ints.length ? "c-ok" : "c-off"} /><Link className="small" href="/system#connections">Open System</Link></div>
        </div>
      </div>

      <div className="grid-2e" style={{ gridTemplateColumns: "minmax(0,1.25fr) minmax(0,1fr)" }}>
        <section className="card pad stack" style={{ gap: 4 }}>
          <div className="between" style={{ paddingBottom: 10 }}>
            <h2 className="lbl">Milestones · {ms.filter((m) => m.done).length} of {ms.length}</h2>
            <span className="small muted">Only real records complete a milestone.</span>
          </div>
          {ms.map((m) => (
            <div key={m.n} style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "11px 0", borderTop: "1px solid var(--line-2)" }}>
              <span className="mono small muted">{m.n}</span>
              <div className="stack" style={{ gap: 2 }}><span style={{ fontWeight: 500 }}>{m.title}</span><span className="small muted">{m.note}</span></div>
              <Chip v={m.state === "DONE" ? "PASS" : m.state} label={m.state} cls={m.state === "DONE" ? "c-ok" : m.state === "BLOCKED" ? "c-block" : m.state === "UNVERIFIED" ? "c-warn" : "c-off"} />
            </div>
          ))}
        </section>

        <div className="stack-lg">
          <section className="card pad stack">
            <h2 className="lbl">Objective & rules</h2>
            <ActionForm op="brand_update" className="stack">
              <label className="field">Objective<textarea name="objective" defaultValue={b.objective} style={{ minHeight: 60 }} /></label>
              <label className="field">Scope<textarea name="description" defaultValue={b.description} style={{ minHeight: 90 }} /></label>
              <details>
                <summary className="small">Brand settings (name, market, disclosure, QA rules)</summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div className="grid-2e" style={{ gap: 8 }}>
                    <label className="field">Name<input type="text" name="name" defaultValue={b.name} /></label>
                    <label className="field">Market (ISO country)<input type="text" name="market" defaultValue={b.market} /></label>
                    <label className="field">Language<input type="text" name="language" defaultValue={b.language} /></label>
                    <label className="field">Currency<input type="text" name="currency" defaultValue={b.currency} maxLength={3} /></label>
                  </div>
                  <label className="field">Affiliate disclosure (default)<textarea name="affiliateDisclosure" defaultValue={st.affiliateDisclosure} style={{ minHeight: 60 }} /></label>
                  <label className="field">Restricted phrases (one per line)<textarea name="restrictedPhrases" defaultValue={st.restrictedPhrases.join("\n")} style={{ minHeight: 120 }} /></label>
                  <label className="field">Minimum article length (characters)<input type="number" name="minBodyChars" defaultValue={st.minBodyChars} min={200} /></label>
                </div>
              </details>
              <Submit>Save</Submit>
            </ActionForm>
          </section>
          <section className="card pad stack" style={{ gap: 4 }}>
            <h2 className="lbl" style={{ marginBottom: 8 }}>Content pillars</h2>
            {pillars.map((p) => {
              const c = counts.find((x) => x.pillar_id === p.id);
              return (
                <ActionForm key={p.id} op="pillar_rename" hidden={{ id: p.id }} className="row" style={{ padding: "8px 0", borderTop: "1px solid var(--line-2)" }}>
                  <input type="text" name="name" defaultValue={p.name} aria-label={`Pillar ${p.name}`} style={{ flex: "1 1 180px" }} />
                  <span className="mono small muted">{c?.n ?? 0} items · {c?.r ?? 0} researched</span>
                  <Submit small>Rename</Submit>
                </ActionForm>
              );
            })}
            <ActionForm op="pillar_add" className="row" resetOnSuccess style={{ paddingTop: 8 }}>
              <input type="text" name="name" placeholder="New pillar" aria-label="New pillar" required style={{ flex: "1 1 180px" }} />
              <Submit small>Add</Submit>
            </ActionForm>
          </section>
        </div>
      </div>

      <div className="grid-2e">
        {avatars.map((a) => (
          <section key={a.id} id="avatar" className="card pad stack">
            <div className="between"><h2 className="lbl">Avatar</h2><Chip v={a.lifecycle_status === "APPROVED" ? "APPROVED" : "x"} label={a.lifecycle_status} cls={a.lifecycle_status === "APPROVED" ? "c-ok" : "c-off"} /></div>
            <div><div style={{ fontSize: 18, fontWeight: 600 }}>{a.name}</div><div className="mono small muted">{a.id}</div></div>
            <ActionForm op="avatar_update" hidden={{ id: a.id }} className="stack">
              <div className="grid-2e" style={{ gap: 8 }}>
                <label className="field">Name<input type="text" name="name" defaultValue={a.name} required /></label>
                <label className="field">Role<input type="text" name="role" defaultValue={a.role} /></label>
                <label className="field">Personality<input type="text" name="personality" defaultValue={a.personality} /></label>
                <label className="field">Voice / tone<input type="text" name="voice_tone" defaultValue={a.voice_tone} /></label>
              </div>
              <label className="field">Short bio<textarea name="bio" defaultValue={a.bio} style={{ minHeight: 60 }} /></label>
              <label className="field">AI disclosure (inserted verbatim in articles)<textarea name="ai_disclosure" defaultValue={a.ai_disclosure} style={{ minHeight: 60 }} required /></label>
              <label className="field">Expertise boundary<textarea name="expertise_boundary" defaultValue={a.expertise_boundary} style={{ minHeight: 60 }} /></label>
              <label className="field">Restricted claims (one per line)<textarea name="restricted_claims" defaultValue={parseJson<string[]>(a.restricted_claims_json, []).join("\n")} style={{ minHeight: 100 }} /></label>
              <div className="grid-2e" style={{ gap: 8 }}>
                <label className="field">Visual reference<input type="text" name="visual_ref" defaultValue={a.visual_ref} placeholder="Not set" /></label>
                <label className="field">Voice reference<input type="text" name="voice_ref" defaultValue={a.voice_ref} placeholder="Out of scope for articles" /></label>
              </div>
              <div className="row"><Submit>Save avatar</Submit><span className="small muted">Editing returns an approved avatar to DRAFT.</span></div>
            </ActionForm>
            {a.lifecycle_status === "DRAFT" ? (
              <ActionForm op="avatar_approve" hidden={{ id: a.id }} className="row">
                <input type="text" name="note" placeholder="Approval note (optional)" aria-label="Approval note" style={{ flex: "1 1 200px" }} />
                <Submit variant="p">Approve configuration</Submit>
              </ActionForm>
            ) : null}
          </section>
        ))}

        <section id="monetization" className="card pad stack">
          <h2 className="lbl">Monetization</h2>
          <div className="grid-3" style={{ gap: 10 }}>
            {[
              ["Discovered", money.discovered, "programs recorded"],
              ["Qualified", money.qualified, "12/12 criteria evidenced"],
              ["Accounts approved", money.accountsApproved, "recorded by you"],
              ["Active offers", money.activeOffers, "live links"],
              ["Attributed revenue", rev.n ? `${b.currency} ${rev.v.toFixed(2)}` : "—", rev.n ? "from imported reports" : "no report imported"],
              ["Profit", rev.n ? `${b.currency} ${(rev.v - cost.v).toFixed(2)}` : "—", rev.n ? "partial: recorded costs only" : "not calculable"],
            ].map(([l, v, n]) => (
              <div key={String(l)} className="tile" style={{ minHeight: 0 }}>
                <span className="small muted">{l}</span>
                <span style={{ fontSize: 18, fontWeight: 600 }}>{v}</span>
                <span className="small muted" style={{ fontSize: 11 }}>{n}</span>
              </div>
            ))}
          </div>
          <div className="row">
            <ActionForm op="find_offers" className="row">
              <input type="text" name="focus" placeholder="Focus (optional)" aria-label="Find offers focus" style={{ width: 180 }} />
              <Submit variant="p">Find offers</Submit>
            </ActionForm>
          </div>
          <p className="small muted">{blockReasons({ type: "FIND_OFFERS", brand_id: brandId, approval_id: null }).join(" ") || "FIND OFFERS searches and records programs as DISCOVERED with page evidence. It never applies, accepts terms or activates links."}</p>

          <h3 className="lbl">Programs · {programs.length}</h3>
          {programs.length === 0 ? <p className="small muted">No programs recorded.</p> : null}
          {programs.map((p) => {
            const facts = listFacts(p.id);
            const gaps = qualificationGaps(p.id);
            return (
              <details key={p.id} className="card" style={{ padding: 12 }}>
                <summary className="row">
                  <strong>{p.name}</strong>
                  <Chip v={p.program_status} />
                  <Chip v={p.account_status} label={`ACCOUNT ${p.account_status}`} cls="c-off" />
                  {p.legacy ? <Chip v="UNVERIFIED" label="LEGACY" /> : null}
                  <span className="small muted">{facts.filter((f) => f.status === "VERIFIED" || f.status === "NOT_APPLICABLE").length}/12 evidenced</span>
                </summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div className="small muted">{p.network} {p.url ? <>· <a href={p.url} target="_blank" rel="noreferrer noopener">{p.url}</a></> : null} · <span className="mono">{p.id}</span></div>
                  <div className="table-scroll">
                    <table className="t">
                      <thead><tr><th>Criterion</th><th>Value · evidence</th><th>Status</th><th>Edit</th></tr></thead>
                      <tbody>
                        {COMMERCIAL_CRITERIA.map((c) => {
                          const f = facts.find((x) => x.criterion === c);
                          return (
                            <tr key={c}>
                              <td className="small mono">{c}</td>
                              <td className="wrap small">
                                {f?.value || <span className="muted">—</span>}
                                {f?.source_url ? <div><a href={f.source_url} target="_blank" rel="noreferrer noopener">source</a> · checked {f.checked_at?.slice(0, 10) ?? "?"}</div> : null}
                                {f?.evidence ? <div className="muted">“{f.evidence.slice(0, 200)}”</div> : null}
                              </td>
                              <td><Chip v={f?.status ?? "UNVERIFIED"} /></td>
                              <td style={{ minWidth: 240 }}>
                                <details>
                                  <summary className="small">Edit</summary>
                                  <ActionForm op="fact_set" hidden={{ id: p.id, criterion: c }} className="stack" style={{ gap: 6, marginTop: 6 }}>
                                    <input type="text" name="value" defaultValue={f?.value ?? ""} placeholder="Value" aria-label="Value" />
                                    <input type="url" name="sourceUrl" defaultValue={f?.source_url ?? ""} placeholder="Source URL" aria-label="Source URL" />
                                    <input type="date" name="checkedAt" defaultValue={f?.checked_at?.slice(0, 10) ?? ""} aria-label="Checked date" />
                                    <textarea name="evidence" defaultValue={f?.evidence ?? ""} placeholder="Evidence (quote)" aria-label="Evidence" style={{ minHeight: 60 }} />
                                    <select name="status" defaultValue={f?.status ?? "UNVERIFIED"} aria-label="Status">{FACT_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
                                    <Submit small>Save</Submit>
                                  </ActionForm>
                                </details>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="row">
                    <ActionForm op="program_qualify" hidden={{ id: p.id }}><Submit small variant="p" disabled={gaps.length > 0 || p.program_status === "QUALIFIED"}>Qualify</Submit></ActionForm>
                    <ActionForm op="program_status" hidden={{ id: p.id, status: "DISQUALIFIED" }}><Submit small>Disqualify</Submit></ActionForm>
                    <ActionForm op="account_status" hidden={{ id: p.id }} className="row">
                      <select name="status" defaultValue={p.account_status} aria-label="Account status" style={{ width: "auto" }}>
                        {["NOT_APPLIED", "APPLIED", "APPROVED", "DECLINED", "NOT_APPLICABLE"].map((s) => <option key={s}>{s}</option>)}
                      </select>
                      <Submit small>Record account status</Submit>
                    </ActionForm>
                  </div>
                  {gaps.length ? <p className="small muted">Qualification gaps: {gaps.join("; ")}</p> : null}
                  <p className="small muted">Applying to a program or accepting its terms is done by you outside this app (Level 4). Record the outcome here.</p>
                </div>
              </details>
            );
          })}
          <details>
            <summary className="btn">Add program manually</summary>
            <ActionForm op="program_add" className="stack" resetOnSuccess style={{ marginTop: 10 }}>
              <div className="grid-2e" style={{ gap: 8 }}>
                <label className="field">Name<input type="text" name="name" required /></label>
                <label className="field">Network<input type="text" name="network" /></label>
              </div>
              <label className="field">Program URL<input type="url" name="url" /></label>
              <label className="field">Notes<input type="text" name="notes" /></label>
              <Submit>Add as DISCOVERED</Submit>
            </ActionForm>
          </details>

          <h3 className="lbl">Offers · {offers.length}</h3>
          {offers.map((o) => {
            const gaps = linkActivationGaps(o.id);
            return (
              <details key={o.id} className="card" style={{ padding: 12 }}>
                <summary className="row"><strong>{o.name}</strong><Chip v={o.offer_status} /><Chip v={o.link_status === "ACTIVE" ? "ACTIVE" : "x"} label={`LINK ${o.link_status}`} cls={o.link_status === "ACTIVE" ? "c-ok" : "c-off"} /></summary>
                <ActionForm op="offer_update" hidden={{ id: o.id }} className="stack" style={{ marginTop: 10 }}>
                  <label className="field">Name<input type="text" name="name" defaultValue={o.name} /></label>
                  <label className="field">Product URL<input type="url" name="productUrl" defaultValue={o.product_url} /></label>
                  <label className="field">Affiliate URL<input type="url" name="affiliateUrl" defaultValue={o.affiliate_url} /></label>
                  <label className="field">Disclosure<textarea name="disclosure" defaultValue={o.disclosure} style={{ minHeight: 50 }} /></label>
                  <label className="field">Commission (as stated by the program)<input type="text" name="commissionText" defaultValue={o.commission_text} /></label>
                  <Submit small>Save offer</Submit>
                </ActionForm>
                <div className="row" style={{ marginTop: 8 }}>
                  <ActionForm op="offer_validity" hidden={{ id: o.id, status: "VALID" }}><Submit small>Mark valid (checked today)</Submit></ActionForm>
                  <ActionForm op="offer_validity" hidden={{ id: o.id, status: "EXPIRED" }}><Submit small>Mark expired</Submit></ActionForm>
                  {o.link_status === "ACTIVE" ? (
                    <ActionForm op="offer_link" hidden={{ id: o.id, status: "INACTIVE" }}><Submit small>Deactivate link</Submit></ActionForm>
                  ) : (
                    <ActionForm op="offer_link" hidden={{ id: o.id, status: "ACTIVE" }}><Submit small variant="p" disabled={gaps.length > 0}>Activate live link</Submit></ActionForm>
                  )}
                </div>
                {gaps.length && o.link_status !== "ACTIVE" ? <p className="small muted">{gaps.join(" ")}</p> : null}
              </details>
            );
          })}
          <details>
            <summary className="btn">Add offer</summary>
            {programs.length === 0 ? <p className="small muted">Record a program first.</p> : (
              <ActionForm op="offer_add" className="stack" resetOnSuccess style={{ marginTop: 10 }}>
                <label className="field">Program<select name="programId">{programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <label className="field">Name<input type="text" name="name" required /></label>
                <label className="field">Product URL<input type="url" name="productUrl" /></label>
                <label className="field">Affiliate URL<input type="url" name="affiliateUrl" /></label>
                <label className="field">Disclosure<textarea name="disclosure" defaultValue={st.affiliateDisclosure} style={{ minHeight: 50 }} /></label>
                <label className="field">Commission (as stated)<input type="text" name="commissionText" /></label>
                <Submit>Add offer</Submit>
              </ActionForm>
            )}
          </details>

          <h3 className="lbl">Reporting import</h3>
          <ActionForm op="perf_import" className="stack">
            <p className="small muted">Affiliate network or analytics exports, mapped to these columns: <span className="mono">{CSV_COLUMNS.join(",")}</span>. Duplicates are skipped by measurement window. Leave “apply” unchecked for a dry run.</p>
            <div className="row">
              <select name="source" aria-label="Source" style={{ width: "auto" }}><option value="affiliate_csv">Affiliate report</option><option value="analytics_csv">Analytics report</option></select>
              <input type="file" name="csv" accept=".csv,text/csv" required aria-label="CSV file" />
              <label className="row small"><input type="checkbox" name="apply" value="1" /> apply</label>
              <Submit>Import</Submit>
            </div>
          </ActionForm>
          <h3 className="lbl">Record a cost</h3>
          <ActionForm op="cost_add" className="row" resetOnSuccess>
            <input type="number" name="amount" step="0.01" min="0" placeholder="Amount" aria-label="Amount" required style={{ width: 110 }} />
            <input type="text" name="currency" defaultValue={b.currency} maxLength={3} aria-label="Currency" style={{ width: 70 }} />
            <select name="category" aria-label="Category" style={{ width: "auto" }}><option value="operating">Operating</option><option value="hosting">Hosting</option><option value="tools">Tools</option><option value="external">External service</option><option value="ai">AI (actual invoice)</option></select>
            <input type="date" name="incurredAt" aria-label="Date" style={{ width: 160 }} />
            <input type="text" name="note" placeholder="Note" aria-label="Note" style={{ flex: "1 1 120px" }} />
            <Submit small>Add</Submit>
          </ActionForm>
        </section>
      </div>
    </main>
  );
}
