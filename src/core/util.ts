import crypto from "node:crypto";

/** Stable, sortable, prefixed IDs: prefix_<time36><random>. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, s: number): string {
  return new Date(new Date(iso).getTime() + s * 1000).toISOString();
}

export function sha256(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** Error with a machine-readable code, safe to show the operator. */
export class AppError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assert(cond: unknown, code: string, message: string, status = 400): asserts cond {
  if (!cond) throw new AppError(code, message, status);
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/g,
  /Basic\s+[A-Za-z0-9+/=]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{8,}/g,
  /(x-api-key|authorization|x-subscription-token|api[_-]?key|password|refresh_token|client_secret|access_token)(["']?\s*[:=]\s*["']?)([^"'\s,}[]+)/gi,
];

/** Redact anything that looks like a credential before it reaches logs, errors or exports. */
export function redact(input: string): string {
  let s = input;
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (_m: string, a?: unknown, b?: unknown) => (typeof a === "string" && typeof b === "string" ? `${a}${b}[REDACTED]` : "[REDACTED]"));
  }
  return s;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
