"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Result =
  | { kind: "navigate"; href: string; message: string }
  | { kind: "list"; title: string; items: { label: string; href: string; detail?: string }[] }
  | { kind: "done"; message: string; href?: string }
  | { kind: "confirm"; message: string; command: string }
  | { kind: "error"; message: string; suggestions: string[] };

export function CommandBox({ aiConnected }: { aiConnected: boolean }) {
  const [value, setValue] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(text: string, confirmed = false) {
    setBusy(true);
    try {
      const r = await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: text, confirmed }) });
      const j = (await r.json()) as Result;
      if (j.kind === "navigate") {
        setRes(null);
        router.push(j.href);
      } else {
        setRes(j);
        if (j.kind === "done") router.refresh();
      }
    } catch (e) {
      setRes({ kind: "error", message: (e as Error).message, suggestions: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cmd">
      <form
        className="dark-field"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) send(value.trim());
        }}
      >
        <span className="mono" aria-hidden="true" style={{ color: "#a6a39b" }}>&gt;</span>
        <input
          ref={inputRef}
          aria-label="Command"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setRes(null)}
          placeholder="Command — try “show approvals” or “help”"
          className="grow"
          style={{ fontSize: 13 }}
          disabled={busy}
        />
        <span className="chip c-dark" title={aiConnected ? "Natural-language commands available" : "AI not connected — structured commands only"}>{aiConnected ? "AI READY" : "NO AI"}</span>
      </form>
      {res ? (
        <div className="cmd-panel" role="dialog" aria-label="Command result">
          <div className="between" style={{ marginBottom: 8 }}>
            <strong>{res.kind === "list" ? res.title : res.kind === "error" ? "Not run" : res.kind === "confirm" ? "Confirm" : "Done"}</strong>
            <button className="btn-link small" onClick={() => setRes(null)}>Close</button>
          </div>
          {res.kind === "list" ? (
            res.items.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {res.items.map((i, n) => (
                  <li key={n} style={{ padding: "4px 0" }}>
                    {i.href === "#" ? (
                      <button className="btn-link mono small" onClick={() => { setValue(i.label.replace(/<.*>/, "")); inputRef.current?.focus(); setRes(null); }}>{i.label}</button>
                    ) : (
                      <a href={i.href} onClick={() => setRes(null)}>{i.label}</a>
                    )}
                    {i.detail ? <span className="muted small"> · {i.detail}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None.</p>
            )
          ) : null}
          {res.kind === "done" ? (
            <p>
              {res.message} {res.href ? <a href={res.href}>Open</a> : null}
            </p>
          ) : null}
          {res.kind === "confirm" ? (
            <div className="stack">
              <p>{res.message}</p>
              <div className="row">
                <button className="btn btn-p btn-sm" onClick={() => send(res.command, true)}>Run “{res.command}”</button>
                <button className="btn btn-sm" onClick={() => setRes(null)}>Cancel</button>
              </div>
            </div>
          ) : null}
          {res.kind === "error" ? (
            <div className="stack">
              <p>{res.message}</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {res.suggestions.map((s) => (
                  <li key={s}>
                    <button className="btn-link mono small" onClick={() => { setValue(s.replace(/<.*>/, "")); inputRef.current?.focus(); }}>{s}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
