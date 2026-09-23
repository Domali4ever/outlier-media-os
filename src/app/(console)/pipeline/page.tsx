import { listPillars, selectedBrandId } from "@/core/brand";
import { listContent } from "@/core/content";
import { listOffers } from "@/core/commercial";
import { capabilityBlockReason } from "@/core/integrations";
import { APPROVAL_STATES, INTENTS, RISKS, STAGES, CAP } from "@/core/types";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Kanban, type KCard } from "@/components/Kanban";

export const dynamic = "force-dynamic";

export default async function PipelinePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const brandId = selectedBrandId();
  const pillars = listPillars(brandId);
  const offers = new Map(listOffers(brandId).map((o) => [o.id, o.name]));
  const items = listContent(brandId, {
    q: sp.q || undefined,
    pillarId: sp.pillar || undefined,
    intent: sp.intent || undefined,
    risk: sp.risk || undefined,
    approval: sp.approval || undefined,
    includeRetired: sp.retired === "1",
  });
  const pname = new Map(pillars.map((p) => [p.id, p.name]));
  const cards: KCard[] = items.map((c) => ({
    id: c.id,
    title: c.title,
    stage: c.stage,
    pillar: c.pillar_id ? pname.get(c.pillar_id) ?? "—" : "No pillar",
    type: c.content_type,
    intent: c.buyer_intent,
    risk: c.risk,
    approval: c.approval,
    offer: c.commercial_decision === "NO_OFFER" ? "none (decided)" : c.target_offer_id ? offers.get(c.target_offer_id) ?? c.target_offer_id : "not set",
    research: c.research_status,
    legacy: !!c.legacy,
    retired: !!c.retired_at,
    revision: c.revision_number,
  }));
  const aiBlock = capabilityBlockReason(CAP.AI);
  const resBlock = capabilityBlockReason(CAP.RESEARCH);
  const pubBlock = capabilityBlockReason(CAP.PUBLISH);
  const anBlock = capabilityBlockReason(CAP.ANALYTICS);
  const empty: Record<string, string> = {
    IDEA: "Empty. Add content with + New content.",
    RESEARCH: aiBlock || resBlock ? `Empty. GENERATE RESEARCH is blocked: ${[aiBlock, resBlock].filter(Boolean).join(" ")}` : "Empty.",
    SCRIPT: "Empty. Items arrive after research with dated sources.",
    QA: aiBlock ? "Empty. Deterministic checks run locally; AI editorial review needs the AI provider (or a recorded human review)." : "Empty.",
    APPROVAL: "Empty. Items arrive after QA passes on their current revision.",
    READY: "Empty. Needs approval on the current revision plus commercial clearance.",
    PUBLISHED: pubBlock ? "Empty. Requires a provider receipt with a remote URL, or evidence-backed manual publication." : "Empty.",
    MEASURE: anBlock ? "Empty. No analytics source connected; CSV import is available in BRAND." : "Empty.",
  };
  const published = items.filter((i) => i.stage === "PUBLISHED" || i.stage === "MEASURE").length;

  return (
    <main className="page" style={{ maxWidth: "none" }}>
      <div className="between" style={{ alignItems: "flex-end" }}>
        <div>
          <h1>Pipeline</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            {items.length} item{items.length === 1 ? "" : "s"} shown · {published} published · editorial, commercial, publication and measurement readiness are tracked separately on each item.
          </p>
        </div>
        <div className="row">
          <a className="btn" href="/api/export">Export JSON</a>
          <details style={{ position: "relative" }}>
            <summary className="btn btn-p" style={{ listStyle: "none" }}>+ New content</summary>
            <div className="card pad" style={{ position: "absolute", right: 0, top: 48, zIndex: 20, width: "min(440px, 90vw)", boxShadow: "0 12px 32px rgba(0,0,0,.15)" }}>
              <ActionForm op="content_create" className="stack">
                <label className="field">Title<input type="text" name="title" required minLength={3} /></label>
                <div className="grid-3" style={{ gap: 8 }}>
                  <label className="field">Pillar
                    <select name="pillarId" defaultValue="">
                      <option value="">None</option>
                      {pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="field">Intent
                    <select name="buyerIntent" defaultValue=""><option value="">Unset</option>{INTENTS.map((i) => <option key={i}>{i}</option>)}</select>
                  </label>
                  <label className="field">Risk
                    <select name="risk" defaultValue="MEDIUM">{RISKS.map((i) => <option key={i}>{i}</option>)}</select>
                  </label>
                </div>
                <label className="field">Content type<input type="text" name="contentType" defaultValue="article" /></label>
                <Submit variant="p">Create in IDEA</Submit>
              </ActionForm>
            </div>
          </details>
        </div>
      </div>

      <form method="get" className="card row" style={{ padding: 12, gap: 10 }} role="search">
        <input type="search" name="q" defaultValue={sp.q ?? ""} placeholder="Search ID, title or claim" aria-label="Search content" style={{ width: 300 }} />
        <label className="row small muted">Pillar
          <select name="pillar" defaultValue={sp.pillar ?? ""} style={{ width: "auto" }}>
            <option value="">All</option>
            {pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="row small muted">Intent
          <select name="intent" defaultValue={sp.intent ?? ""} style={{ width: "auto" }}>
            <option value="">Any</option>
            <option value="UNSET">Unset</option>
            {INTENTS.map((i) => <option key={i}>{i}</option>)}
          </select>
        </label>
        <label className="row small muted">Risk
          <select name="risk" defaultValue={sp.risk ?? ""} style={{ width: "auto" }}><option value="">Any</option>{RISKS.map((i) => <option key={i}>{i}</option>)}</select>
        </label>
        <label className="row small muted">Approval
          <select name="approval" defaultValue={sp.approval ?? ""} style={{ width: "auto" }}><option value="">Any</option>{APPROVAL_STATES.map((i) => <option key={i}>{i}</option>)}</select>
        </label>
        <label className="row small muted"><input type="checkbox" name="retired" value="1" defaultChecked={sp.retired === "1"} /> Show retired</label>
        <button className="btn" type="submit">Apply</button>
        <a className="small" href="/pipeline">Reset</a>
      </form>

      <Kanban stages={[...STAGES]} cards={cards} empty={empty} />
    </main>
  );
}
