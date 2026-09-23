import Link from "next/link";
import { selectedBrandId } from "@/core/brand";
import { isCapabilityReady } from "@/core/integrations";
import { activityFeed, attentionSummary, needsDecision, nextAction, sinceLastCheckIn } from "@/core/today";
import { CAP } from "@/core/types";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Chip } from "@/components/Chip";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  MEASURED: "MEASURED",
  NOT_CONNECTED: "NOT CONNECTED",
  NO_DATA: "NO DATA",
  STALE: "STALE",
  PARTIAL: "PARTIAL",
  ESTIMATED: "ESTIMATED",
  NOT_CALCULABLE: "UNKNOWN",
};

function fmt(iso: string) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export default async function TodayPage() {
  const brandId = selectedBrandId();
  const s = sinceLastCheckIn(brandId);
  const decisions = needsDecision(brandId);
  const next = nextAction(brandId);
  const attention = attentionSummary(brandId);
  const feed = activityFeed(10);
  const ai = isCapabilityReady(CAP.AI);

  return (
    <main className="page">
      <div className="between" style={{ alignItems: "flex-end" }}>
        <div>
          <h1>Today</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            {s.firstSession ? "Last check-in: none recorded — summaries start from brand creation." : `Last check-in: ${fmt(s.since)}.`} Now {fmt(new Date().toISOString())}.
          </p>
        </div>
        <ActionForm op="checkin">
          <Submit>Record check-in</Submit>
        </ActionForm>
      </div>

      <div className="grid-2">
        <div className="stack-lg">
          <section className="card pad stack" aria-labelledby="since-h">
            <div className="between">
              <h2 id="since-h" className="lbl">Since last check-in</h2>
              <span className="mono small muted">From {fmt(s.since)} · {s.currency}</span>
            </div>
            <div className="grid-5">
              {s.tiles.map((t) => (
                <div key={t.key} className="tile">
                  <div className="small muted">{t.label}</div>
                  <div className="v">{t.value}</div>
                  <div><Chip v={t.state} label={STATE_LABEL[t.state]} /></div>
                  <div className="small muted" style={{ fontSize: 11 }}>{t.source}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="card pad" aria-labelledby="dec-h">
            <div className="between" style={{ paddingBottom: 12 }}>
              <h2 id="dec-h" className="lbl">Needs your decision · {decisions.length}</h2>
              <ActionForm op="rec_refresh">
                <Submit small>Refresh recommendations</Submit>
              </ActionForm>
            </div>
            {decisions.length === 0 ? (
              <p className="muted small" style={{ borderTop: "1px solid var(--line-2)", paddingTop: 14 }}>
                No open recommendations or approvals. Recommendations only appear when stored data supports them (INVESTIGATE when data is insufficient).
              </p>
            ) : null}
            {decisions.map((d) => (
              <article key={`${d.kind}-${d.id}`} className="stack" style={{ padding: "18px 0", borderTop: "1px solid var(--line-2)" }}>
                <div className="row">
                  <Chip v={d.type} />
                  <span className="mono small muted">{d.subjectId}</span>
                  <span className="grow" />
                  {d.confidence !== "—" ? <Chip v={d.confidence} label={`CONFIDENCE ${d.confidence}`} cls="c-off" /> : null}
                  {d.sufficiency !== "—" ? <Chip v={d.sufficiency} label={`DATA ${d.sufficiency}`} /> : null}
                </div>
                <h3 style={{ fontSize: 17, fontWeight: 600 }}>{d.title}</h3>
                <dl className="kv" style={{ gridTemplateColumns: "110px minmax(0,1fr)" }}>
                  <dt>Reason</dt>
                  <dd>{d.reason}</dd>
                  <dt>Evidence</dt>
                  <dd>{d.evidence.join(" · ") || "—"}</dd>
                  {d.upside ? (<><dt>Upside</dt><dd>{d.upside}</dd></>) : null}
                  {d.risks ? (<><dt>Risks</dt><dd>{d.risks}</dd></>) : null}
                </dl>
                <div className="row">
                  <Link className="btn btn-p" href={d.href}>Review</Link>
                  {d.kind === "recommendation" ? (
                    <>
                      <ActionForm op="rec_decide" hidden={{ id: d.id, decision: "APPROVED" }}><Submit>Approve</Submit></ActionForm>
                      <ActionForm op="rec_decide" hidden={{ id: d.id, decision: "REJECTED" }}><Submit>Reject</Submit></ActionForm>
                      {d.href.startsWith("/pipeline/") ? (
                        <ActionForm op="rec_fix" hidden={{ id: d.id }}>
                          <Submit disabled={!ai} title={ai ? undefined : "AI not connected"}>{ai ? "Fix with AI" : "Fix with AI · AI not connected"}</Submit>
                        </ActionForm>
                      ) : null}
                    </>
                  ) : null}
                  {d.kind === "approval" ? <span className="small muted">Approve or reject on the item itself — the approval binds to the exact revision you review.</span> : null}
                </div>
              </article>
            ))}
          </section>
        </div>

        <div className="stack-lg">
          <section className="card pad stack" style={{ borderColor: "var(--ink)" }} aria-labelledby="next-h">
            <h2 id="next-h" className="lbl">Next recommended action</h2>
            {next.kind === "none" ? (
              <p className="muted">No next action is derivable from the stored state.</p>
            ) : (
              <>
                <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.25 }}>{next.label}</div>
                <p style={{ color: "var(--ink-2)" }}>{next.reason}</p>
                {next.blockers.length ? (
                  <div className="msg note small">{next.blockers.join(" · ")}</div>
                ) : null}
                {next.kind === "run" ? (
                  <ActionForm op="run" hidden={{ jobType: next.jobType, contentId: next.contentId }}>
                    <Submit variant="p">Run</Submit>
                  </ActionForm>
                ) : (
                  <Link className="btn btn-p" href={next.href!} style={{ alignSelf: "flex-start" }}>
                    Open
                  </Link>
                )}
              </>
            )}
          </section>

          <section className="card pad stack" style={{ gap: 4 }} aria-labelledby="act-h">
            <div className="between" style={{ paddingBottom: 8 }}>
              <h2 id="act-h" className="lbl">Automated activity</h2>
              <Link href="/system#log" className="small">Full log</Link>
            </div>
            {feed.length === 0 ? <p className="muted small">No events yet.</p> : null}
            {feed.map((e) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "64px minmax(0,1fr)", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line-2)", fontSize: 13 }}>
                <span className="mono small muted" title={e.at}>{e.at.slice(11, 16)}</span>
                <span>
                  {e.level !== "INFO" ? <Chip v={e.level === "WARN" ? "WARN" : "FAIL"} label={e.level} /> : null} {e.summary.length > 220 ? `${e.summary.slice(0, 220)}…` : e.summary}
                </span>
              </div>
            ))}
          </section>
        </div>
      </div>

      <div className="card row" style={{ padding: "14px 18px" }}>
        <Chip v={attention.quiet ? "PASS" : "WARN"} label={attention.quiet ? "ALL CLEAR" : "ATTENTION"} />
        <span>{attention.message}</span>
      </div>
    </main>
  );
}
