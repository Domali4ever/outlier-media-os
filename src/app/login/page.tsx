import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, operatorConfigured, validateSession } from "@/core/auth";
import { boot } from "@/lib/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  boot();
  const c = await cookies();
  if (operatorConfigured() && validateSession(c.get(SESSION_COOKIE)?.value)) redirect("/");
  const setup = !operatorConfigured();
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card pad stack" style={{ width: "min(420px, 100%)" }}>
        <div className="mono" style={{ fontWeight: 600, letterSpacing: ".16em" }}>OUTLIER MEDIA OS</div>
        <h1 style={{ fontSize: 22 }}>{setup ? "Set the operator password" : "Sign in"}</h1>
        {setup ? <p className="muted small">First run on this machine. The password is stored as a scrypt hash in the local database. Use 12+ characters.</p> : null}
        <LoginForm setup={setup} />
      </div>
    </main>
  );
}
