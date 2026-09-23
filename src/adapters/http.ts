import { redact, truncate } from "@/core/util";

export class ProviderError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
  /** Authentication/permission problem: the integration is degraded; jobs should block, not retry. */
  auth: boolean;
  /** The request may have reached the provider (timeout/network drop after send). */
  maybeDelivered: boolean;
  retryAfterSeconds?: number;
  provider: string;
  constructor(p: { provider: string; code: string; message: string; status?: number; retryable?: boolean; auth?: boolean; maybeDelivered?: boolean; retryAfterSeconds?: number }) {
    super(redact(p.message));
    this.provider = p.provider;
    this.code = p.code;
    this.status = p.status;
    this.retryable = !!p.retryable;
    this.auth = !!p.auth;
    this.maybeDelivered = !!p.maybeDelivered;
    this.retryAfterSeconds = p.retryAfterSeconds;
  }
}

export type FetchLike = typeof fetch;

/** Injection point for contract tests (isolated fake providers). Never set in production code. */
let fetchImpl: FetchLike | null = null;
export function __setFetchForTests(f: FetchLike | null) {
  fetchImpl = f;
}
function doFetch(): FetchLike {
  return fetchImpl ?? fetch;
}

export interface RequestOpts {
  provider: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Raw text response instead of JSON. */
  text?: boolean;
  maxBytes?: number;
}

/**
 * HTTP call with timeout, size cap and uniform error translation.
 * Status mapping: 401/403 → auth (blocking); 408/425/429/5xx → retryable; other 4xx → permanent.
 */
export async function request<T = unknown>(o: RequestOpts): Promise<{ status: number; data: T; headers: Headers }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 30_000);
  let res: Response;
  const method = o.method ?? (o.body !== undefined ? "POST" : "GET");
  try {
    res = await doFetch()(o.url, {
      method,
      headers: { ...(o.body !== undefined && typeof o.body !== "string" ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) },
      body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
      signal: ctrl.signal,
      redirect: "follow",
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error).name === "AbortError";
    throw new ProviderError({
      provider: o.provider,
      code: aborted ? "TIMEOUT" : "NETWORK",
      message: aborted ? `${o.provider}: request timed out after ${(o.timeoutMs ?? 30_000) / 1000}s` : `${o.provider}: network error — ${(e as Error).message}`,
      retryable: true,
      maybeDelivered: method !== "GET",
    });
  }
  let raw: string;
  try {
    const buf = await res.arrayBuffer();
    if (o.maxBytes && buf.byteLength > o.maxBytes) raw = new TextDecoder().decode(buf.slice(0, o.maxBytes));
    else raw = new TextDecoder().decode(buf);
  } catch (e) {
    clearTimeout(timer);
    throw new ProviderError({ provider: o.provider, code: "READ_FAILED", message: `${o.provider}: failed reading response — ${(e as Error).message}`, retryable: true, maybeDelivered: method !== "GET" });
  }
  clearTimeout(timer);
  if (!res.ok) {
    let msg = truncate(raw, 400);
    try {
      const j = JSON.parse(raw);
      msg = j?.error?.message ?? j?.message ?? j?.error_description ?? (typeof j?.error === "string" ? j.error : msg);
    } catch {
      /* not json */
    }
    const s = res.status;
    const ra = Number(res.headers.get("retry-after"));
    throw new ProviderError({
      provider: o.provider,
      code: s === 401 ? "UNAUTHORIZED" : s === 403 ? "FORBIDDEN" : s === 429 ? "RATE_LIMITED" : s >= 500 ? "PROVIDER_ERROR" : "BAD_REQUEST",
      status: s,
      message: `${o.provider} HTTP ${s}: ${msg}`,
      auth: s === 401 || s === 403,
      retryable: s === 408 || s === 425 || s === 429 || s >= 500,
      retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? ra : undefined,
      maybeDelivered: s >= 500 && method !== "GET",
    });
  }
  if (o.text) return { status: res.status, data: raw as T, headers: res.headers };
  try {
    return { status: res.status, data: (raw ? JSON.parse(raw) : {}) as T, headers: res.headers };
  } catch {
    throw new ProviderError({ provider: o.provider, code: "BAD_RESPONSE", message: `${o.provider}: response was not valid JSON`, retryable: false });
  }
}
