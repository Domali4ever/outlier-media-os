/**
 * Contract tests against ISOLATED FAKE providers. They verify request shape, auth handling,
 * schema validation and error translation. They are not live verification.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { structured, testAnthropic } from "@/adapters/anthropic";
import { fetchPage, htmlToText, search } from "@/adapters/brave";
import { driveExportText, ga4Report } from "@/adapters/google";
import { ProviderError, request } from "@/adapters/http";
import { testIntegration } from "@/adapters/registry";
import { createPost, findBySlug, slugFor, testWordPress, toHtml } from "@/adapters/wordpress";
import { connectIntegration, getIntegration } from "@/core/integrations";
import { CAP } from "@/core/types";
import { fakeFetch, freshDb } from "./helpers";

describe("http error translation", () => {
  it("maps statuses to auth / retryable / permanent", async () => {
    freshDb(false);
    for (const [status, auth, retry] of [[401, true, false], [403, true, false], [429, false, true], [503, false, true], [400, false, false]] as const) {
      fakeFetch(() => ({ status, json: { error: { message: "nope" } } }));
      const e = await request({ provider: "p", url: "https://x.example" }).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.auth).toBe(auth);
      expect(e.retryable).toBe(retry);
    }
  });
  it("timeouts on POST are flagged as possibly delivered", async () => {
    freshDb(false);
    fakeFetch(() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })));
    const e = await request({ provider: "p", url: "https://x.example", body: {} }).catch((x) => x);
    expect(e.code).toBe("TIMEOUT");
    expect(e.maybeDelivered).toBe(true);
  });
});

describe("Anthropic adapter", () => {
  it("sends a forced tool call with the API key header and validates the output", async () => {
    freshDb(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-000000000000";
    process.env.ANTHROPIC_MODEL = "claude-test";
    process.env.ANTHROPIC_PRICE_INPUT_PER_MTOK = "3";
    process.env.ANTHROPIC_PRICE_OUTPUT_PER_MTOK = "15";
    const calls = fakeFetch(() => ({ json: { model: "claude-test", stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "tool_use", name: "t", input: { n: 3 } }] } }));
    const r = await structured({ system: "s", user: "u", toolName: "t", toolDescription: "d", jsonSchema: { type: "object" }, schema: z.object({ n: z.number() }) });
    expect(r.value.n).toBe(3);
    expect(r.costEstimate).toBeCloseTo(0.0045);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.tool_choice).toEqual({ type: "tool", name: "t" });
    expect(body.model).toBe("claude-test");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-ant-test-000000000000");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });
  it("rejects structured output that fails the schema", async () => {
    freshDb(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-000000000000";
    fakeFetch(() => ({ json: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", name: "t", input: { n: "three" } }] } }));
    const e = await structured({ system: "s", user: "u", toolName: "t", toolDescription: "d", jsonSchema: {}, schema: z.object({ n: z.number() }) }).catch((x) => x);
    expect(e.code).toBe("SCHEMA_VALIDATION");
  });
  it("test fails when the configured model is not available", async () => {
    freshDb(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-000000000000";
    process.env.ANTHROPIC_MODEL = "missing-model";
    fakeFetch(() => ({ json: { data: [{ id: "other-model" }] } }));
    await expect(testAnthropic()).rejects.toThrow(/not available/);
  });
});

describe("integration state machine", () => {
  it("CONNECT without configuration stays NOT_CONNECTED; a saved key is not CONNECTED until a test passes", async () => {
    freshDb();
    expect(connectIntegration(CAP.RESEARCH, "operator").missing).toEqual(["BRAVE_SEARCH_API_KEY"]);
    process.env.BRAVE_SEARCH_API_KEY = "brv-test";
    expect(connectIntegration(CAP.RESEARCH, "operator").state).toBe("CONFIGURING");
    fakeFetch(() => ({ status: 401, json: { message: "bad token" } }));
    expect((await testIntegration(CAP.RESEARCH, "operator")).ok).toBe(false);
    expect(getIntegration(CAP.RESEARCH).state).toBe("CONFIGURING");
    fakeFetch(() => ({ json: { web: { results: [{ title: "t", url: "https://a.example", description: "<b>d</b>" }] } } }));
    expect((await testIntegration(CAP.RESEARCH, "operator")).ok).toBe(true);
    expect(getIntegration(CAP.RESEARCH).state).toBe("CONNECTED");
    // A later failure degrades rather than silently staying connected.
    fakeFetch(() => ({ status: 401, json: { message: "revoked" } }));
    await testIntegration(CAP.RESEARCH, "operator");
    expect(getIntegration(CAP.RESEARCH).state).toBe("DEGRADED");
  });
});

describe("Brave + page fetch", () => {
  it("maps search results and strips markup from fetched pages", async () => {
    freshDb(false);
    process.env.BRAVE_SEARCH_API_KEY = "brv-test";
    const calls = fakeFetch((url) =>
      url.includes("search.brave.com")
        ? { json: { web: { results: [{ title: "T", url: "https://m.example/p", description: "a <strong>b</strong>", page_age: "2026-01-01" }] } } }
        : { text: "<html><title>Maker</title><script>x()</script><p>Keep filters dry.</p></html>", headers: { "content-type": "text/html" } },
    );
    const r = await search("cpap filters", 3, "CA");
    expect(r[0]).toMatchObject({ title: "T", url: "https://m.example/p", description: "a b", age: "2026-01-01" });
    expect((calls[0].init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brv-test");
    expect(calls[0].url).toContain("country=ca");
    const p = await fetchPage("https://m.example/p");
    expect(p.finalTitle).toBe("Maker");
    expect(p.text).toContain("Keep filters dry.");
    expect(p.text).not.toContain("x()");
    expect(htmlToText("<p>a</p><p>b</p>").text).toBe("a\nb");
  });
});

describe("WordPress adapter", () => {
  it("requires https, publish_posts, and returns receipts", async () => {
    freshDb(false);
    process.env.WP_BASE_URL = "http://insecure.example";
    process.env.WP_USERNAME = "u";
    process.env.WP_APP_PASSWORD = "p p p";
    await expect(testWordPress()).rejects.toThrow(/https/);
    process.env.WP_BASE_URL = "https://blog.example";
    fakeFetch(() => ({ json: { id: 1, name: "Ed", capabilities: { read: true } } }));
    await expect(testWordPress()).rejects.toThrow(/lacks publish_posts/);
    fakeFetch(() => ({ json: { id: 1, name: "Ed", roles: ["editor"], capabilities: { publish_posts: true } } }));
    expect((await testWordPress()).detail).toMatch(/Ed/);
    const calls = fakeFetch((url, init) => (init.method === "POST" ? { status: 201, json: { id: 9, link: "https://blog.example/a", status: "publish", slug: "a" } } : { json: [] }));
    const post = await createPost({ title: "A", html: "<p>x</p>", slug: "a", status: "publish" });
    expect(post.link).toBe("https://blog.example/a");
    expect(calls[0].url).toBe("https://blog.example/wp-json/wp/v2/posts");
    expect(await findBySlug("a")).toBeNull();
    expect(slugFor("content_abc123def456", 3, "Packing a CPAP!")).toMatch(/^packing-a-cpap-.*-r3$/);
    expect(toHtml("## H\n\n- a\n- b\n\nSee [x](https://e.example) <script>")).toContain("&lt;script&gt;");
  });
});

describe("Google adapters", () => {
  it("refreshes the token, exports Docs as text and maps GA4 rows", async () => {
    freshDb(false);
    Object.assign(process.env, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", GOOGLE_REFRESH_TOKEN: "rt-1", GA4_PROPERTY_ID: "123" });
    const calls = fakeFetch((url) => {
      if (url.includes("oauth2")) return { json: { access_token: "at", expires_in: 3600 } };
      if (url.includes("/export")) return { text: "Doc body", headers: { "content-type": "text/plain" } };
      if (url.includes("drive/v3/files")) return { json: { id: "abcdefghij12", name: "Blueprint", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-01T00:00:00Z" } };
      if (url.includes("runReport")) return { json: { rows: [{ dimensionValues: [{ value: "/packing" }, { value: "20260920" }], metricValues: [{ value: "12" }, { value: "9" }] }] } };
      return { status: 404, json: {} };
    });
    const d = await driveExportText("abcdefghij12");
    expect(d.text).toBe("Doc body");
    const rows = await ga4Report("28daysAgo", "yesterday");
    expect(rows[0]).toEqual({ pagePath: "/packing", date: "2026-09-20", views: 12, users: 9 });
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1); // token cached
    expect((calls.find((c) => c.url.includes("runReport"))!.init.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });
});
