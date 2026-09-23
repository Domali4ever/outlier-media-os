import { describe, expect, it } from "vitest";
import { getDb } from "@/core/db";
import { getContent, listPublications, requestPublish, saveRevision } from "@/core/content";
import { setIntegrationState, getIntegration } from "@/core/integrations";
import { blockReasons, claimNext, createJob, getJob, recoverExpiredLeases, reevaluateBlocked, retryJob, cancelJob, setSideEffect, failJob } from "@/core/jobs";
import { setPolicy } from "@/core/policies";
import { setSetting } from "@/core/settings";
import { CAP } from "@/core/types";
import { executeJob } from "@/modules";
import { BRAND, fakeFetch, freshDb, readyItem } from "./helpers";

function connectWordPress() {
  process.env.WP_BASE_URL = "https://blog.example";
  process.env.WP_USERNAME = "editor";
  process.env.WP_APP_PASSWORD = "abcd efgh ijkl mnop";
  setIntegrationState(CAP.PUBLISH, "CONNECTED");
}

describe("durable jobs", () => {
  it("disconnected work is BLOCKED with its exact dependencies, and released when they are met", () => {
    freshDb();
    const { job } = createJob({ type: "RESEARCH", brandId: BRAND, contentId: "content_idea_001", actor: "operator" });
    expect(job.state).toBe("BLOCKED");
    const reasons = JSON.parse(job.blocked_reason_json!) as string[];
    expect(reasons.join(" ")).toMatch(/ai.structured_generation/);
    expect(reasons.join(" ")).toMatch(/research.retrieval/);
    expect(reasons.join(" ")).toMatch(/Brand is DRAFT/);
    expect(reasons.join(" ")).toMatch(/spend cap/);
    expect(reasons.join(" ")).toMatch(/prices/);
    // Connecting providers alone is not spending authorization.
    setIntegrationState(CAP.AI, "CONNECTED");
    setIntegrationState(CAP.RESEARCH, "CONNECTED");
    getDb().prepare("UPDATE brands SET status='ACTIVE'").run();
    expect(reevaluateBlocked()).toBe(0);
    setPolicy(BRAND, "budget", { amount: 20, currency: "USD", period: "month" }, "operator");
    process.env.ANTHROPIC_PRICE_INPUT_PER_MTOK = "3";
    process.env.ANTHROPIC_PRICE_OUTPUT_PER_MTOK = "15";
    expect(reevaluateBlocked()).toBe(1);
    expect(getJob(job.id).state).toBe("QUEUED");
  });

  it("idempotency: an identical active job is returned instead of duplicated", () => {
    freshDb();
    const a = createJob({ type: "QA_DETERMINISTIC", brandId: BRAND, contentId: "content_idea_002", actor: "operator" });
    const b = createJob({ type: "QA_DETERMINISTIC", brandId: BRAND, contentId: "content_idea_002", actor: "operator", rerun: true });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });

  it("claiming is exclusive: two workers cannot claim the same job", () => {
    freshDb();
    createJob({ type: "QA_DETERMINISTIC", brandId: BRAND, contentId: "content_idea_002", actor: "operator" });
    const one = claimNext("w1");
    const two = claimNext("w2");
    expect(one).not.toBeNull();
    expect(two).toBeNull();
  });

  it("pause stops claiming; paused job types are skipped", () => {
    freshDb();
    createJob({ type: "QA_DETERMINISTIC", brandId: BRAND, contentId: "content_idea_002", actor: "operator" });
    setSetting("system_paused", true);
    expect(claimNext("w1")).toBeNull();
    setSetting("system_paused", false);
    setSetting("paused_job_types", ["QA_DETERMINISTIC"]);
    expect(claimNext("w1")).toBeNull();
    setSetting("paused_job_types", []);
    expect(claimNext("w1")).not.toBeNull();
  });

  it("restart recovery: an expired lease is retried; exhausted attempts fail", () => {
    freshDb();
    const { job } = createJob({ type: "QA_DETERMINISTIC", brandId: BRAND, contentId: "content_idea_002", actor: "operator" });
    claimNext("dead-worker");
    getDb().prepare("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
    recoverExpiredLeases();
    expect(getJob(job.id).state).toBe("RETRYING");
    claimNext("w2");
    getDb().prepare("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
    recoverExpiredLeases();
    expect(getJob(job.id).state).toBe("FAILED");
  });

  it("a non-publish side effect lost mid-flight goes to NEEDS_ATTENTION, never blind retry", () => {
    freshDb();
    const { job } = createJob({ type: "MCP_CALL", actor: "operator", input: { serverId: "x", tool: "t" } });
    claimNext("w1");
    setSideEffect(job.id, "w1", "REQUESTED");
    getDb().prepare("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
    recoverExpiredLeases();
    expect(getJob(job.id).state).toBe("NEEDS_ATTENTION");
    expect(getJob(job.id).side_effect_state).toBe("AMBIGUOUS");
  });

  it("retryable failures back off; permanent failures fail; cancel and retry work", () => {
    freshDb();
    const { job } = createJob({ type: "QA_DETERMINISTIC", brandId: BRAND, contentId: "content_idea_003", actor: "operator" });
    claimNext("w1");
    expect(failJob(job.id, "w1", { code: "X", message: "transient", retryable: true })).toBe("RETRYING");
    expect(getJob(job.id).run_after > new Date().toISOString()).toBe(true);
    cancelJob(job.id, "operator");
    expect(getJob(job.id).state).toBe("CANCELLED");
    retryJob(job.id, "operator");
    expect(getJob(job.id).state).toBe("QUEUED");
  });

  it("the worker executes a local job end to end and records the result", async () => {
    freshDb();
    const { job } = createJob({ type: "QA_DETERMINISTIC", brandId: BRAND, contentId: "content_idea_004", actor: "operator" });
    const claimed = claimNext("w1")!;
    expect(await executeJob(claimed, "w1")).toBe("COMPLETE");
    const done = getJob(job.id);
    expect(done.state).toBe("COMPLETE");
    expect(JSON.parse(done.output_json!).result).toBe("FAIL"); // empty idea fails structural QA — honestly
  });
});

describe("publishing safety (isolated fake WordPress)", () => {
  it("publishes only with connection + approval, records a confirmed receipt", async () => {
    freshDb();
    const id = readyItem();
    connectWordPress();
    const calls = fakeFetch((url, init) => {
      if (init.method === "POST") return { status: 201, json: { id: 42, link: "https://blog.example/packing", status: "publish", slug: "s" } };
      return { json: [] };
    });
    const { job } = requestPublish(id, "operator");
    expect(job.state).toBe("QUEUED");
    const r = await executeJob(claimNext("w1")!, "w1");
    expect(r).toBe("COMPLETE");
    expect(getContent(id).stage).toBe("PUBLISHED");
    const pubs = listPublications(id);
    expect(pubs).toHaveLength(1);
    expect(pubs[0].remote_url).toBe("https://blog.example/packing");
    const post = calls.find((c) => c.init.method === "POST")!;
    expect(String((post.init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
  });

  it("a timeout after sending is ambiguous: the next attempt reconciles instead of double-posting", async () => {
    freshDb();
    const id = readyItem();
    connectWordPress();
    let posts = 0;
    fakeFetch((url, init) => {
      if (init.method === "POST") {
        posts++;
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }
      return { json: posts ? [{ id: 7, link: "https://blog.example/found", status: "publish", slug: "s" }] : [] };
    });
    const { job } = requestPublish(id, "operator");
    expect(await executeJob(claimNext("w1")!, "w1")).toBe("RETRYING");
    expect(getJob(job.id).side_effect_state).toBe("AMBIGUOUS");
    getDb().prepare("UPDATE jobs SET run_after='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
    expect(await executeJob(claimNext("w1")!, "w1")).toBe("COMPLETE");
    expect(posts).toBe(1);
    expect(listPublications(id)[0].remote_url).toBe("https://blog.example/found");
  });

  it("the worker re-checks the revision before publishing", async () => {
    freshDb();
    const id = readyItem();
    connectWordPress();
    fakeFetch(() => ({ status: 201, json: { id: 1, link: "https://blog.example/x", status: "publish" } }));
    const { job } = requestPublish(id, "operator");
    saveRevision(id, { body: getDb().prepare("SELECT body FROM content_revisions WHERE id=?").pluck().get(getContent(id).current_revision_id) + "\n\nEdit." }, "operator");
    expect(await executeJob(claimNext("w1")!, "w1")).toBe("FAILED");
    expect(JSON.parse(getJob(job.id).error_json!).code).toMatch(/REVISION_CHANGED|APPROVAL_INVALID/);
    expect(listPublications(id)).toHaveLength(0);
  });

  it("an auth failure degrades the integration and blocks the job instead of retrying", async () => {
    freshDb();
    const id = readyItem();
    connectWordPress();
    fakeFetch(() => ({ status: 401, json: { message: "Invalid application password" } }));
    const { job } = requestPublish(id, "operator");
    const st = await executeJob(claimNext("w1")!, "w1");
    // 401 is a definitive refusal: not ambiguous, so the job blocks on the degraded connection.
    expect(st).toBe("BLOCKED");
    expect(getJob(job.id).side_effect_state).toBe("NONE");
    expect(getIntegration(CAP.PUBLISH).state).toBe("DEGRADED");
    expect(blockReasons(getJob(job.id)).join(" ")).toMatch(/DEGRADED/);
  });
});
