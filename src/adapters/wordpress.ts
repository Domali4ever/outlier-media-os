import { getSecret } from "@/core/settings";
import { ProviderError, request } from "./http";

/**
 * WordPress REST API adapter (wp/v2).
 * Docs: https://developer.wordpress.org/rest-api/reference/posts/ and
 * https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/
 * Auth: Basic <username:application-password> over HTTPS.
 */
function cfg() {
  const base = getSecret("WP_BASE_URL");
  const user = getSecret("WP_USERNAME");
  const pass = getSecret("WP_APP_PASSWORD");
  if (!base || !user || !pass)
    throw new ProviderError({ provider: "wordpress", code: "NOT_CONFIGURED", message: "WP_BASE_URL, WP_USERNAME and WP_APP_PASSWORD are required", auth: true });
  const u = new URL(base);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname))
    throw new ProviderError({ provider: "wordpress", code: "INSECURE", message: "WP_BASE_URL must use https (application passwords are sent with every request)", auth: true });
  return {
    api: `${u.origin}${u.pathname.replace(/\/$/, "")}/wp-json/wp/v2`,
    auth: `Basic ${Buffer.from(`${user}:${pass.replace(/\s+/g, "")}`).toString("base64")}`,
  };
}

export interface WpPost {
  id: number;
  link: string;
  status: string;
  slug: string;
  modified_gmt?: string;
}

export async function testWordPress() {
  const c = cfg();
  const r = await request<{ id: number; name: string; capabilities?: Record<string, boolean>; roles?: string[] }>({
    provider: "wordpress",
    url: `${c.api}/users/me?context=edit`,
    headers: { Authorization: c.auth },
    timeoutMs: 15_000,
  });
  const caps = r.data.capabilities ?? {};
  const capabilities = ["auth.read"];
  if (caps.publish_posts) capabilities.push("posts.publish (reported by WordPress; not exercised by the test)");
  if (!caps.publish_posts)
    throw new ProviderError({ provider: "wordpress", code: "NO_PUBLISH_CAPABILITY", message: `Authenticated as ${r.data.name}, but the user lacks publish_posts. Read access is not publish access.`, auth: true });
  return { ok: true as const, detail: `Authenticated as ${r.data.name} (${(r.data.roles ?? []).join(", ") || "role hidden"})`, capabilities };
}

/** Deterministic slug per content revision — used to reconcile after an ambiguous publish. */
export function slugFor(contentId: string, revisionNumber: number, title: string): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${base}-${contentId.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase()}-r${revisionNumber}`;
}

export async function findBySlug(slug: string): Promise<WpPost | null> {
  const c = cfg();
  const r = await request<WpPost[]>({
    provider: "wordpress",
    url: `${c.api}/posts?slug=${encodeURIComponent(slug)}&status=publish,future,draft,pending,private&context=edit`,
    headers: { Authorization: c.auth },
    timeoutMs: 20_000,
  });
  return r.data[0] ?? null;
}

export async function createPost(p: { title: string; html: string; slug: string; status: "publish" | "draft"; excerpt?: string }): Promise<WpPost> {
  const c = cfg();
  const r = await request<WpPost>({
    provider: "wordpress",
    url: `${c.api}/posts`,
    method: "POST",
    headers: { Authorization: c.auth },
    body: { title: p.title, content: p.html, slug: p.slug, status: p.status, excerpt: p.excerpt ?? "" },
    timeoutMs: 45_000,
  });
  if (!r.data?.id || !r.data?.link) throw new ProviderError({ provider: "wordpress", code: "BAD_RECEIPT", message: "WordPress response had no post id/link", maybeDelivered: true, retryable: false });
  return r.data;
}

/** Minimal, safe Markdown-ish → HTML for article bodies (headings, lists, links, paragraphs). */
export function toHtml(body: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, "%22")}" rel="nofollow sponsored noopener">${t}</a>`);
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    list = null;
  };
  for (const block of body.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      list = lines.map((l) => l.replace(/^\s*[-*] /, ""));
      flush();
      continue;
    }
    const h = block.match(/^(#{1,4})\s+(.*)$/);
    if (h && lines.length === 1) {
      const lvl = Math.min(4, h[1].length + 1);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
