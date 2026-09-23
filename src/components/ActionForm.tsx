"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { act, type ActionState } from "@/app/actions";
import { JobWatch } from "./JobWatch";

const initial: ActionState = { ok: true, message: "" };

export function ActionForm({
  op,
  hidden,
  children,
  className,
  style,
  confirmText,
  resetOnSuccess,
  showJob = true,
}: {
  op: string;
  hidden?: Record<string, string | undefined | null>;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  confirmText?: string;
  resetOnSuccess?: boolean;
  showJob?: boolean;
}) {
  const [state, formAction] = useActionState(act, initial);
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.redirect) router.push(state.redirect);
    if (state.ok && state.at && resetOnSuccess) ref.current?.reset();
  }, [state, router, resetOnSuccess]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      style={style}
      onSubmit={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
    >
      <input type="hidden" name="op" value={op} />
      {hidden && Object.entries(hidden).map(([k, v]) => (v == null ? null : <input key={k} type="hidden" name={k} value={v} />))}
      {children}
      {state.message ? (
        <div role="status" className={`msg ${state.ok ? "ok" : "err"}`} style={{ marginTop: 8, width: "100%" }}>
          {state.message}
        </div>
      ) : null}
      {showJob && state.jobId ? <JobWatch jobId={state.jobId} key={`${state.jobId}-${state.at}`} /> : null}
    </form>
  );
}

export function Submit({ children, variant = "s", disabled, title, small }: { children: React.ReactNode; variant?: "p" | "s"; disabled?: boolean; title?: string; small?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn ${variant === "p" ? "btn-p" : ""} ${small ? "btn-sm" : ""}`} disabled={disabled || pending} aria-busy={pending} title={title}>
      {pending ? "Working…" : children}
    </button>
  );
}
