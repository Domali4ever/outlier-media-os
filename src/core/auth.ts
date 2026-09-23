import crypto from "node:crypto";
import { getDb } from "./db";
import { audit } from "./audit";
import { getSetting, setSetting } from "./settings";
import { AppError, addSeconds, nowIso, sha256 } from "./util";

export const SESSION_COOKIE = "omos_session";
const SESSION_SECONDS = 60 * 60 * 12;

function hashPassword(pw: string, salt = crypto.randomBytes(16).toString("hex")): string {
  const dk = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return `scrypt$${salt}$${dk}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, dk] = stored.split("$");
  if (alg !== "scrypt" || !salt || !dk) return false;
  const test = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(dk, "hex");
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

export function operatorConfigured(): boolean {
  return !!getSetting<string | null>("operator_password_hash", null);
}

/** First-run setup. Only possible while no operator password exists. */
export function setupOperator(password: string) {
  if (operatorConfigured()) throw new AppError("ALREADY_SET", "An operator password already exists.", 409);
  if (password.length < 12) throw new AppError("WEAK_PASSWORD", "Use at least 12 characters.");
  setSetting("operator_password_hash", hashPassword(password));
  audit({ actor: "operator", action: "auth.setup", subjectType: "system", subjectId: "auth", summary: "Operator password set" });
}

export function changePassword(current: string, next: string) {
  const stored = getSetting<string | null>("operator_password_hash", null);
  if (!stored || !verifyPassword(current, stored)) throw new AppError("BAD_CREDENTIALS", "Current password is incorrect.", 401);
  if (next.length < 12) throw new AppError("WEAK_PASSWORD", "Use at least 12 characters.");
  setSetting("operator_password_hash", hashPassword(next));
  getDb().prepare("DELETE FROM sessions").run();
  audit({ actor: "operator", action: "auth.change", subjectType: "system", subjectId: "auth", summary: "Operator password changed; all sessions revoked", level: "WARN" });
}

const attempts = new Map<string, { n: number; until: number }>();

export function login(password: string, clientKey: string, userAgent: string | null): { token: string; expires: string } {
  const a = attempts.get(clientKey);
  if (a && a.until > Date.now()) throw new AppError("RATE_LIMITED", "Too many attempts. Wait a minute.", 429);
  const stored = getSetting<string | null>("operator_password_hash", null);
  if (!stored || !verifyPassword(password, stored)) {
    const n = (a?.n ?? 0) + 1;
    attempts.set(clientKey, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    audit({ actor: "anonymous", action: "auth.fail", subjectType: "system", subjectId: "auth", summary: "Failed login attempt", level: "WARN" });
    throw new AppError("BAD_CREDENTIALS", "Incorrect password.", 401);
  }
  attempts.delete(clientKey);
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = addSeconds(nowIso(), SESSION_SECONDS);
  getDb().prepare("INSERT INTO sessions (id, created_at, expires_at, user_agent) VALUES (?,?,?,?)").run(sha256(token), nowIso(), expires, (userAgent ?? "").slice(0, 200));
  getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  audit({ actor: "operator", action: "auth.login", subjectType: "system", subjectId: "auth", summary: "Operator signed in" });
  return { token, expires };
}

export function validateSession(token: string | undefined | null): boolean {
  if (!token) return false;
  const r = getDb().prepare("SELECT expires_at FROM sessions WHERE id = ?").get(sha256(token)) as { expires_at: string } | undefined;
  return !!r && r.expires_at > nowIso();
}

export function logout(token: string | undefined | null) {
  if (token) getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
}
