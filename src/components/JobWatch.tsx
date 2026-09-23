"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface JobView {
  id: string;
  type: string;
  state: string;
  progress: string;
  blocked: string[];
  error: string | null;
  events: { at: string; state: string; message: string }[];
}

const TERMINAL = ["COMPLETE", "FAILED", "CANCELLED", "NEEDS_ATTENTION", "BLOCKED"];

/** Shows a job's real, persisted progress by polling the server. */
export function JobWatch({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    let stop = false;
    let last = "";
    const poll = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as JobView;
        if (stop) return;
        setJob(j);
        if (j.state !== last) {
          if (last) router.refresh();
          last = j.state;
        }
        if (!TERMINAL.includes(j.state)) setTimeout(poll, 2000);
      } catch (e) {
        if (!stop) setErr((e as Error).message);
      }
    };
    poll();
    return () => {
      stop = true;
    };
  }, [jobId, router]);
  if (err) return <div className="msg err">Could not load job {jobId}: {err}</div>;
  if (!job) return <div className="msg note">Loading job {jobId}…</div>;
  const cls = job.state === "COMPLETE" ? "c-ok" : job.state === "BLOCKED" || job.state === "FAILED" ? "c-block" : job.state === "NEEDS_ATTENTION" ? "c-warn" : "c-info";
  return (
    <div className="msg note stack" style={{ gap: 6, marginTop: 8, width: "100%" }} aria-live="polite">
      <div className="row">
        <span className="mono small">{job.id}</span>
        <span className={`chip ${cls}`}>{job.state}</span>
        <span className="small muted">{job.type}</span>
      </div>
      {job.progress && !TERMINAL.includes(job.state) ? <div className="small">{job.progress}</div> : null}
      {job.blocked.length ? <div className="small">Waiting on: {job.blocked.join(" ")}</div> : null}
      {job.error ? <div className="small">Error: {job.error}</div> : null}
      {job.state === "QUEUED" ? <div className="small muted">Queued — the worker process picks it up within seconds if it is running (npm start).</div> : null}
    </div>
  );
}
