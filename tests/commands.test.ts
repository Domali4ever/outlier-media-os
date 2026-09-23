import { describe, expect, it } from "vitest";
import { dispatch, dispatchStructured } from "@/core/commands";
import { isSystemPaused, pausedJobTypes } from "@/core/settings";
import { BRAND, freshDb } from "./helpers";

describe("command dispatcher", () => {
  it("structured commands work without AI and go through the same gates", async () => {
    freshDb();
    expect((await dispatch("help", "operator", BRAND)).kind).toBe("list");
    expect(dispatchStructured("open content_idea_001", "operator", BRAND)).toMatchObject({ kind: "navigate", href: "/pipeline/content_idea_001" });
    dispatchStructured("pause workflow PUBLISH", "operator", BRAND);
    expect(pausedJobTypes()).toContain("PUBLISH");
    dispatchStructured("pause all", "operator", BRAND);
    expect(isSystemPaused()).toBe(true);
    dispatchStructured("resume all", "operator", BRAND);
    const r = dispatchStructured("generate research content_idea_001", "operator", BRAND);
    expect(r).toMatchObject({ kind: "done" });
    expect((r as { message: string }).message).toMatch(/BLOCKED/);
    expect(dispatchStructured("show blocked jobs", "operator", BRAND)).toMatchObject({ kind: "list" });
  });
  it("natural language without an AI provider says so and offers structured commands", async () => {
    freshDb();
    const r = await dispatch("what should I approve today?", "operator", BRAND);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toMatch(/AI not connected/);
  });
  it("there is no command that publishes or approves", () => {
    freshDb();
    expect(dispatchStructured("publish content_idea_001", "operator", BRAND)).toBeNull();
    expect(dispatchStructured("approve content_idea_001", "operator", BRAND)).toBeNull();
  });
});
