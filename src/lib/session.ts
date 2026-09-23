import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, operatorConfigured, validateSession } from "@/core/auth";
import { getDb } from "@/core/db";
import { seedIfEmpty } from "@/core/seed";
import { AppError } from "@/core/util";

let booted = false;
export function boot() {
  if (booted) return;
  getDb();
  seedIfEmpty();
  booted = true;
}

/** For pages: redirects to /login when there is no valid operator session. */
export async function requirePageSession() {
  boot();
  if (!operatorConfigured()) redirect("/login?setup=1");
  const c = await cookies();
  if (!validateSession(c.get(SESSION_COOKIE)?.value)) redirect("/login");
}

/** For server actions and route handlers: throws unless the caller is the signed-in operator. */
export async function requireOperator(): Promise<"operator"> {
  boot();
  const c = await cookies();
  if (!validateSession(c.get(SESSION_COOKIE)?.value)) throw new AppError("UNAUTHENTICATED", "Sign in again.", 401);
  return "operator";
}

/** CSRF defence for route handlers: same-origin requests only. Server actions have Next's own origin check. */
export async function assertSameOrigin() {
  const h = await headers();
  const origin = h.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (origin && host && new URL(origin).host !== host) throw new AppError("CSRF", "Cross-origin request refused.", 403);
}

export async function systemDetailsOn(): Promise<boolean> {
  return (await cookies()).get("omos_sd")?.value === "1";
}
