"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { act } from "@/app/actions";

export interface KCard {
  id: string;
  title: string;
  stage: string;
  pillar: string;
  type: string;
  intent: string | null;
  risk: string;
  approval: string;
  offer: string;
  research: string;
  legacy: boolean;
  retired: boolean;
  revision: number;
}

const RISK_CLS: Record<string, string> = { LOW: "c-ok", MEDIUM: "c-warn", HIGH: "c-block", BLOCKED: "c-block" };
const APPROVAL_CLS: Record<string, string> = { APPROVED: "c-ok", PENDING: "c-info", REJECTED: "c-block", EXPIRED: "c-warn", NOT_REQUIRED: "c-off" };

export function Kanban({ stages, cards, empty }: { stages: string[]; cards: KCard[]; empty: Record<string, string> }) {
  const [over, setOver] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function move(id: string, stage: string) {
    const fd = new FormData();
    fd.set("op", "content_move");
    fd.set("id", id);
    fd.set("stage", stage);
    start(async () => {
      const r = await act({ ok: true, message: "" }, fd);
      setMsg({ ok: r.ok, text: r.ok ? `${id}: ${r.message}` : `${id} not moved — ${r.message}` });
      router.refresh();
    });
  }

  return (
    <div className="stack">
      {msg ? <div role="status" className={`msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}
      <div className="kanban" aria-busy={pending}>
        {stages.map((st) => {
          const list = cards.filter((c) => c.stage === st);
          return (
            <section
              key={st}
              aria-label={st}
              className={`col ${over === st ? "over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(st);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData("text/plain");
                const card = cards.find((c) => c.id === id);
                if (card && card.stage !== st) move(id, st);
              }}
            >
              <div className={`col-h ${list.length ? "has" : ""}`}>
                <h2 className="lbl" style={{ color: list.length ? "var(--ink)" : undefined }}>{st}</h2>
                <span className="mono small">{list.length}</span>
              </div>
              {list.length === 0 ? <div className="empty">{empty[st]}</div> : null}
              {list.map((c) => (
                <Link
                  key={c.id}
                  href={`/pipeline/${c.id}`}
                  className="kcard"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}
                  style={c.retired ? { opacity: 0.6 } : undefined}
                >
                  <span className="mono small muted">{c.id}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{c.title}</span>
                  <span className="small muted">
                    {c.pillar} · {c.type} · rev {c.revision} · offer: {c.offer}
                  </span>
                  <span className="row" style={{ gap: 4 }}>
                    {c.research === "UNRESEARCHED" ? <span className="chip c-off">UNRESEARCHED</span> : null}
                    {c.legacy ? <span className="chip c-warn">LEGACY · UNVERIFIED</span> : null}
                    {c.retired ? <span className="chip c-off">RETIRED</span> : null}
                    <span className="chip c-off">INTENT {c.intent ?? "—"}</span>
                    <span className={`chip ${RISK_CLS[c.risk]}`}>RISK {c.risk}</span>
                    <span className={`chip ${APPROVAL_CLS[c.approval]}`}>{c.approval}</span>
                  </span>
                </Link>
              ))}
            </section>
          );
        })}
      </div>
      <p className="small muted">Drag a card to request a stage change, or open it and use the workflow actions (keyboard friendly). The server checks every move — dragging cannot skip QA, approval or commercial gates.</p>
    </div>
  );
}
