import { getSecret } from "@/core/settings";
import { sha256, truncate } from "@/core/util";
import { ProviderError, request } from "./http";

/**
 * Brave Search API adapter.
 * Docs: https://api-dashboard.search.brave.com/app/documentation/web-search — GET /res/v1/web/search,
 * header X-Subscription-Token. Pages are then fetched directly so the stored evidence is the source itself.
 */
const BASE = "https://api.search.brave.com/res/v1/web/search";

function token(): string {
  const k = getSecret("BRAVE_SEARCH_API_KEY");
  if (!k) throw new ProviderError({ provider: "brave", code: "NOT_CONFIGURED", message: "BRAVE_SEARCH_API_KEY is not set", auth: true });
  return k;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

export async function search(q: string, count = 8, country?: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, count: String(Math.min(20, Math.max(1, count))), safesearch: "moderate" });
  if (country) params.set("country", country.toLowerCase());
  const r = await request<{ web?: { results?: { title: string; url: string; description?: string; age?: string; page_age?: string }[] } }>({
    provider: "brave",
    url: `${BASE}?${params}`,
    headers: { "X-Subscription-Token": token(), Accept: "application/json" },
    timeoutMs: 15_000,
  });
  return (r.data.web?.results ?? []).map((x) => ({ title: x.title, url: x.url, description: stripTags(x.description ?? ""), age: x.page_age ?? x.age }));
}

export async function testBrave() {
  const r = await search("cpap travel case", 1);
  if (!Array.isArray(r)) throw new ProviderError({ provider: "brave", code: "BAD_RESPONSE", message: "Unexpected search response" });
  return { ok: true as const, detail: `Search returned ${r.length} result(s)`, capabilities: ["web.search"] };
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim());
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  const text = stripTags(body).replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return { title, text };
}

export interface FetchedPage {
  url: string;
  finalTitle: string;
  text: string;
  sha256: string;
  fetchedAt: string;
}

/** Fetches a source page (untrusted). Text is truncated; the hash lets later checks detect changes. */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new ProviderError({ provider: "web", code: "BAD_URL", message: "Only http(s) pages are fetched" });
  const r = await request<string>({
    provider: "web",
    url,
    text: true,
    timeoutMs: 15_000,
    maxBytes: 1_500_000,
    headers: { "User-Agent": "OutlierMediaOS/1.0 (research evidence fetch)", Accept: "text/html,application/xhtml+xml,text/plain" },
  });
  const { title, text } = htmlToText(r.data);
  return { url, finalTitle: title, text: truncate(text, 20_000), sha256: sha256(r.data), fetchedAt: new Date().toISOString() };
}
