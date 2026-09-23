import { describe, expect, it } from "vitest";
import path from "node:path";
import { closeDb, currentSchemaVersion, getDb, migrate, openDbAt } from "@/core/db";
import { createContent, listContent } from "@/core/content";
import { SCHEMA_VERSION } from "@/core/migrations";
import { freshDb } from "./helpers";

describe("persistence and honest initial state", () => {
  it("seeds only configuration — no fake operational history", () => {
    freshDb();
    const db = getDb();
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    expect(count("brands")).toBe(1);
    expect(count("pillars")).toBe(5);
    expect(count("avatars")).toBe(1);
    expect(count("content_items")).toBe(8);
    for (const t of ["jobs", "approvals", "publications", "performance_observations", "costs", "recommendations", "qa_reports", "programs"]) expect(count(t)).toBe(0);
    const b = db.prepare("SELECT status FROM brands").get() as { status: string };
    expect(b.status).toBe("DRAFT");
    const a = db.prepare("SELECT lifecycle_status FROM avatars").get() as { lifecycle_status: string };
    expect(a.lifecycle_status).toBe("DRAFT");
    expect(listContent("brand_cpap_travel").every((c) => c.research_status === "UNRESEARCHED")).toBe(true);
    const states = db.prepare("SELECT DISTINCT state FROM integrations").all() as { state: string }[];
    expect(states.map((s) => s.state).sort()).toEqual(["LOCAL", "NOT_CONNECTED", "OUT_OF_SCOPE"]);
  });

  it("data survives closing and reopening the database (app/worker restart)", () => {
    const { dir } = freshDb();
    const id = createContent("brand_cpap_travel", { title: "Persistent item" }, "operator");
    closeDb();
    openDbAt(path.join(dir, "data", "outlier.db"));
    expect(listContent("brand_cpap_travel").some((c) => c.id === id)).toBe(true);
  });

  it("migrations are recorded and idempotent", () => {
    freshDb();
    expect(currentSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(migrate(getDb()).applied).toEqual([]);
  });
});
