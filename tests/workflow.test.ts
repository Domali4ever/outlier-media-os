import { describe, expect, it } from "vitest";
import { approveAvatar, setBrandStatus } from "@/core/brand";
import {
  addClaim,
  addEvidence,
  approveContent,
  approvalState,
  checkTransition,
  createContent,
  getContent,
  moveStage,
  recordHumanReview,
  recordManualPublication,
  rejectContent,
  requestPublish,
  runQaNow,
  saveRevision,
  setClaimStatus,
  updateContentMeta,
} from "@/core/content";
import { addOffer, addProgram, qualifyProgram, setAccountStatus, setFact, setLinkStatus, setOfferValidity } from "@/core/commercial";
import { COMMERCIAL_CRITERIA } from "@/core/types";
import { AppError } from "@/core/util";
import { freshDb, LONG_BODY } from "./helpers";

const B = "brand_cpap_travel";

function toApproval() {
  const id = createContent(B, { title: "How to pack a CPAP for flights", risk: "LOW" }, "operator");
  moveStage(id, "RESEARCH", "operator");
  addEvidence({ brandId: B, contentId: id, kind: "WEB_SOURCE", url: "https://example.com/guide", title: "Guide", excerpt: "…", checkedAt: new Date().toISOString() }, "operator");
  moveStage(id, "SCRIPT", "operator");
  saveRevision(id, { body: LONG_BODY() }, "operator");
  moveStage(id, "QA", "operator");
  expect(runQaNow(id, "operator").result).not.toBe("FAIL");
  recordHumanReview(id, "PASS", "Checked every statement against the cited guide.", "operator");
  moveStage(id, "APPROVAL", "operator");
  return id;
}

describe("server-side workflow gates", () => {
  it("advances one stage at a time and enforces evidence and script gates", () => {
    freshDb();
    const id = createContent(B, { title: "Gate test item" }, "operator");
    expect(checkTransition(getContent(id), "SCRIPT")[0]).toMatch(/one at a time/);
    moveStage(id, "RESEARCH", "operator");
    expect(() => moveStage(id, "SCRIPT", "operator")).toThrow(/dated source/);
    addEvidence({ brandId: B, contentId: id, kind: "MANUAL_NOTE", title: "Note", checkedAt: new Date().toISOString() }, "operator");
    moveStage(id, "SCRIPT", "operator");
    expect(() => moveStage(id, "QA", "operator")).toThrow(/script of at least/);
  });

  it("QA → APPROVAL needs deterministic QA and an editorial review on the current revision", () => {
    freshDb();
    const id = createContent(B, { title: "Editorial gate item" }, "operator");
    moveStage(id, "RESEARCH", "operator");
    addEvidence({ brandId: B, contentId: id, kind: "WEB_SOURCE", url: "https://example.com/a", title: "A", checkedAt: new Date().toISOString() }, "operator");
    moveStage(id, "SCRIPT", "operator");
    saveRevision(id, { body: "x".repeat(700) }, "operator");
    const r = runQaNow(id, "operator");
    expect(r.result).toBe("FAIL"); // no AI disclosure
    expect(r.findings.some((f) => f.check === "ai_disclosure" && f.severity === "FAIL")).toBe(true);
    expect(() => moveStage(id, "APPROVAL", "operator")).toThrow();
  });

  it("deterministic QA flags restricted phrases and personal-use claims", () => {
    freshDb();
    const id = createContent(B, { title: "Restricted phrase item" }, "operator");
    saveRevision(id, { body: LONG_BODY("This mask is clinically proven and I tested it on my CPAP.") }, "operator");
    const r = runQaNow(id, "operator");
    expect(r.findings.find((f) => f.check === "restricted_phrases")?.severity).toBe("FAIL");
    expect(r.findings.find((f) => f.check === "no_personal_use")?.severity).toBe("FAIL");
  });

  it("unresolved high-risk claims block editorial readiness; VERIFIED needs dated source", () => {
    freshDb();
    const id = toApproval();
    rejectContent(id, "operator", "Add battery claim");
    const c = addClaim(id, { text: "Runs 2 nights on battery X", claimType: "ELECTRICAL" }, "operator");
    runQaNow(id, "operator"); // RUN QA moves SCRIPT → QA when the script gate passes
    expect(getContent(id).stage).toBe("QA");
    expect(() => moveStage(id, "APPROVAL", "operator")).toThrow(/claim/);
    const noteEv = addEvidence({ brandId: B, contentId: id, kind: "MANUAL_NOTE", title: "hearsay" }, "operator");
    expect(() => setClaimStatus(c, "VERIFIED", noteEv, "operator")).toThrow(/source URL and a checked date/);
    const ev = addEvidence({ brandId: B, contentId: id, kind: "WEB_SOURCE", url: "https://maker.example/battery", title: "Battery spec", checkedAt: new Date().toISOString() }, "operator");
    setClaimStatus(c, "VERIFIED", ev, "operator");
    runQaNow(id, "operator");
    recordHumanReview(id, "PASS", "Re-checked the battery claim against the maker page.", "operator");
    moveStage(id, "APPROVAL", "operator");
  });

  it("approval is human-only, bound to the revision; edits invalidate it", () => {
    freshDb();
    const id = toApproval();
    expect(() => approveContent(id, "worker")).toThrow(AppError);
    expect(() => approveContent(id, "command")).toThrow(/human/);
    const before = getContent(id).current_revision_id;
    approveContent(id, "operator", "ok", before);
    expect(approvalState(getContent(id))).toBe("APPROVED");
    const r = saveRevision(id, { body: LONG_BODY("One more paragraph.") }, "operator");
    expect(r.invalidated).toBe(1);
    expect(getContent(id).stage).toBe("SCRIPT");
    expect(approvalState(getContent(id))).not.toBe("APPROVED");
  });

  it("stale approval page is refused", () => {
    freshDb();
    const id = toApproval();
    expect(() => approveContent(id, "operator", "", "rev_stale")).toThrow(/changed since you opened it/);
  });

  it("READY needs commercial clearance; PUBLISHED can never be reached by moving", () => {
    freshDb();
    const id = toApproval();
    approveContent(id, "operator");
    expect(() => moveStage(id, "READY", "operator")).toThrow(/NO_OFFER/);
    updateContentMeta(id, { commercialDecision: "NO_OFFER" }, "operator");
    // Commercial change invalidated the approval: re-approve.
    expect(approvalState(getContent(id))).not.toBe("APPROVED");
    approveContent(id, "operator");
    moveStage(id, "READY", "operator");
    expect(() => moveStage(id, "PUBLISHED", "operator")).toThrow(/confirmed provider receipt/);
  });

  it("publishing without a connected destination creates a BLOCKED job, not a publication", () => {
    freshDb();
    approveAvatar("avatar_cpap_guide_001", "operator");
    setBrandStatus(B, "ACTIVE", "operator");
    const id = toApproval();
    updateContentMeta(id, { commercialDecision: "NO_OFFER" }, "operator");
    approveContent(id, "operator");
    moveStage(id, "READY", "operator");
    expect(() => requestPublish(id, "worker")).toThrow(/operator/);
    const { job } = requestPublish(id, "operator");
    expect(job.state).toBe("BLOCKED");
    expect(job.blocked_reason_json).toMatch(/publish.primary/);
    expect(getContent(id).stage).toBe("READY");
  });

  it("manual publication requires evidence and a bound approval", () => {
    freshDb();
    const id = toApproval();
    updateContentMeta(id, { commercialDecision: "NO_OFFER" }, "operator");
    approveContent(id, "operator");
    moveStage(id, "READY", "operator");
    expect(() => recordManualPublication(id, { url: "https://blog.example/p", proofNote: "" }, "operator")).toThrow(/confirmed/);
    recordManualPublication(id, { url: "https://blog.example/p", proofNote: "Opened the URL in a private window; live." }, "operator");
    expect(getContent(id).stage).toBe("PUBLISHED");
    expect(() => moveStage(id, "READY", "operator")).toThrow(/cannot move back/);
  });

  it("brand activation requires an approved avatar; only the operator changes status", () => {
    freshDb();
    expect(() => setBrandStatus(B, "ACTIVE", "operator")).toThrow(/avatar/);
    approveAvatar("avatar_cpap_guide_001", "operator");
    expect(() => setBrandStatus(B, "ACTIVE", "worker")).toThrow(/operator/);
    setBrandStatus(B, "ACTIVE", "operator");
  });
});

describe("commercial gates", () => {
  it("programs are never auto-qualified; links need qualified + approved account + valid offer", () => {
    freshDb();
    const p = addProgram(B, { name: "Example Supplies Affiliate", url: "https://aff.example" }, "worker");
    expect(() => qualifyProgram(p, "operator")).toThrow(/Cannot qualify/);
    expect(() => setFact(p, "commission", { value: "8%", status: "VERIFIED" }, "operator")).toThrow(/source URL/);
    for (const c of COMMERCIAL_CRITERIA)
      setFact(p, c, { value: "stated", sourceUrl: "https://aff.example/terms", checkedAt: "2026-09-01", evidence: "Quoted from the terms page.", status: c === "ai_video_policy" ? "NOT_APPLICABLE" : "VERIFIED" }, "operator");
    expect(() => qualifyProgram(p, "worker")).toThrow(/operator/);
    qualifyProgram(p, "operator");
    const o = addOffer(B, { programId: p, name: "Travel case", productUrl: "https://shop.example/case", affiliateUrl: "https://aff.example/r?id=1", disclosure: "Affiliate link disclosure." }, "operator");
    expect(() => setLinkStatus(o, "ACTIVE", "operator")).toThrow(/Account is NOT_APPLIED/);
    setAccountStatus(p, "APPROVED", "operator");
    setOfferValidity(o, "VALID", "operator");
    setLinkStatus(o, "ACTIVE", "operator");
    // A fact regression demotes the program and deactivates links.
    setFact(p, "commission", { value: "changed", status: "UNVERIFIED" }, "operator");
    expect(() => setLinkStatus(o, "ACTIVE", "operator")).toThrow(/QUALIFIED/);
  });

  it("changing the target offer invalidates approvals bound to the old commercial configuration", () => {
    freshDb();
    const id = toApproval();
    updateContentMeta(id, { commercialDecision: "NO_OFFER" }, "operator");
    approveContent(id, "operator");
    expect(approvalState(getContent(id))).toBe("APPROVED");
    updateContentMeta(id, { commercialDecision: "UNDECIDED" }, "operator");
    expect(approvalState(getContent(id))).not.toBe("APPROVED");
  });
});
