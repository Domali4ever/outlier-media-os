import { getSecret } from "@/core/settings";
import { ProviderError, request } from "./http";

/**
 * Google OAuth 2.0 (refresh-token grant), Drive API v3 and GA4 Data API v1beta.
 * Docs: https://developers.google.com/identity/protocols/oauth2/web-server#offline
 *       https://developers.google.com/drive/api/reference/rest/v3
 *       https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
 */
let cached: { token: string; exp: number; fp: string } | null = null;

async function accessToken(provider: string): Promise<string> {
  const id = getSecret("GOOGLE_CLIENT_ID");
  const secret = getSecret("GOOGLE_CLIENT_SECRET");
  const refresh = getSecret("GOOGLE_REFRESH_TOKEN");
  if (!id || !secret || !refresh) throw new ProviderError({ provider, code: "NOT_CONFIGURED", message: "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are required", auth: true });
  const fp = `${id}:${refresh.slice(-6)}`;
  if (cached && cached.fp === fp && cached.exp > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }).toString();
  try {
    const r = await request<{ access_token: string; expires_in: number; scope?: string }>({
      provider,
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      timeoutMs: 15_000,
    });
    cached = { token: r.data.access_token, exp: Date.now() + r.data.expires_in * 1000, fp };
    return r.data.access_token;
  } catch (e) {
    if (e instanceof ProviderError && e.status === 400) throw new ProviderError({ provider, code: "OAUTH_INVALID_GRANT", message: `${provider}: refresh token rejected (${e.message}). Re-run the consent flow.`, auth: true });
    throw e;
  }
}

/* ------------------------------------------------------------- Drive */

export async function testDrive() {
  const t = await accessToken("google_drive");
  const r = await request<{ user?: { emailAddress?: string; displayName?: string } }>({
    provider: "google_drive",
    url: "https://www.googleapis.com/drive/v3/about?fields=user",
    headers: { Authorization: `Bearer ${t}` },
    timeoutMs: 15_000,
  });
  return { ok: true as const, detail: `Drive access for ${r.data.user?.emailAddress ?? r.data.user?.displayName ?? "account"}`, capabilities: ["drive.files.read"] };
}

export function driveIdFromInput(input: string): string {
  const m = input.match(/\/d\/([A-Za-z0-9_-]{10,})/) ?? input.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(input.trim())) return input.trim();
  throw new ProviderError({ provider: "google_drive", code: "BAD_INPUT", message: "Not a Drive file link or ID" });
}

export async function driveExportText(fileId: string): Promise<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string; text: string }> {
  const t = await accessToken("google_drive");
  const h = { Authorization: `Bearer ${t}` };
  const meta = await request<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }>({
    provider: "google_drive",
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`,
    headers: h,
  });
  let text: string;
  if (meta.data.mimeType === "application/vnd.google-apps.document") {
    text = (await request<string>({ provider: "google_drive", url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`, headers: h, text: true, maxBytes: 5_000_000 })).data;
  } else if (meta.data.mimeType.startsWith("text/")) {
    text = (await request<string>({ provider: "google_drive", url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, headers: h, text: true, maxBytes: 5_000_000 })).data;
  } else {
    throw new ProviderError({ provider: "google_drive", code: "UNSUPPORTED_TYPE", message: `${meta.data.mimeType} is not supported; import Google Docs or text files, or upload the file locally.` });
  }
  return { ...meta.data, text };
}

/* --------------------------------------------------------------- GA4 */

function property(): string {
  const p = getSecret("GA4_PROPERTY_ID");
  if (!p || !/^\d+$/.test(p)) throw new ProviderError({ provider: "ga4", code: "NOT_CONFIGURED", message: "GA4_PROPERTY_ID (numeric) is required", auth: true });
  return p;
}

export interface Ga4Row {
  pagePath: string;
  date: string;
  views: number;
  users: number;
}

export async function ga4Report(startDate: string, endDate: string, limit = 10000): Promise<Ga4Row[]> {
  const t = await accessToken("ga4");
  const r = await request<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>({
    provider: "ga4",
    url: `https://analyticsdata.googleapis.com/v1beta/properties/${property()}:runReport`,
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
    body: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "pagePath" }, { name: "date" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      limit,
    },
    timeoutMs: 30_000,
  });
  return (r.data.rows ?? []).map((row) => ({
    pagePath: row.dimensionValues[0].value,
    date: `${row.dimensionValues[1].value.slice(0, 4)}-${row.dimensionValues[1].value.slice(4, 6)}-${row.dimensionValues[1].value.slice(6, 8)}`,
    views: Number(row.metricValues[0].value),
    users: Number(row.metricValues[1].value),
  }));
}

export async function testGa4() {
  await ga4Report("7daysAgo", "today", 1);
  return { ok: true as const, detail: `runReport succeeded for property ${property()}`, capabilities: ["analytics.read"] };
}
