"use client";

import { useActionState } from "react";
import { authAction, type ActionState } from "@/app/actions";

export function LoginForm({ setup }: { setup: boolean }) {
  const [state, action, pending] = useActionState(authAction, { ok: true, message: "" } as ActionState);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="op" value={setup ? "setup" : "login"} />
      <label className="field">
        Password
        <input type="password" name="password" required minLength={setup ? 12 : 1} autoComplete={setup ? "new-password" : "current-password"} autoFocus />
      </label>
      {setup ? (
        <label className="field">
          Confirm password
          <input type="password" name="confirm" required minLength={12} autoComplete="new-password" />
        </label>
      ) : null}
      <button className="btn btn-p" type="submit" disabled={pending}>{pending ? "Working…" : setup ? "Set password and sign in" : "Sign in"}</button>
      {state.message ? <div role="alert" className="msg err">{state.message}</div> : null}
    </form>
  );
}
