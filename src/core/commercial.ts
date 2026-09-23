import { getDb, tx } from "./db";
import { audit } from "./audit";
import { COMMERCIAL_CRITERIA, FACT_STATUSES, type FactStatus } from "./types";
import { AppError, assert, newId, nowIso, sha256, stableStringify } from "./util";

export interface ProgramRow {
  id: string;
  brand_id: string;
  name: string;
  network: string;
  url: string;
  program_status: "DISCOVERED" | "QUALIFIED" | "DISQUALIFIED" | "RETIRED";
  account_status: "NOT_APPLIED" | "APPLIED" | "APPROVED" | "DECLINED" | "NOT_APPLICABLE";
  notes: string;
  legacy: number;
  origin_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface FactRow {
  id: string;
  program_id: string;
  criterion: string;
  value: string;
  source_url: string | null;
  checked_at: string | null;
  evidence: string;
  status: FactStatus;
  provenance_json: string;
  updated_at: string;
}
export interface OfferRow {
  id: string;
  brand_id: string;
  program_id: string;
  name: string;
  product_url: string;
  affiliate_url: string;
  disclosure: string;
  offer_status: "DRAFT" | "VALID" | "EXPIRED" | "INVALID";
  link_status: "INACTIVE" | "ACTIVE";
  commission_text: string;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

function validUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:";
  } catch {
    return false;
  }
}

export function listPrograms(brandId: string): ProgramRow[] {
  return getDb().prepare("SELECT * FROM programs WHERE brand_id = ? ORDER BY created_at").all(brandId) as ProgramRow[];
}
export function getProgram(id: string): ProgramRow {
  const p = getDb().prepare("SELECT * FROM programs WHERE id = ?").get(id) as ProgramRow | undefined;
  if (!p) throw new AppError("NOT_FOUND", "Program not found", 404);
  return p;
}
export function listFacts(programId: string): FactRow[] {
  return getDb().prepare("SELECT * FROM commercial_facts WHERE program_id = ?").all(programId) as FactRow[];
}
export function listOffers(brandId: string): OfferRow[] {
  return getDb().prepare("SELECT * FROM offers WHERE brand_id = ? ORDER BY created_at").all(brandId) as OfferRow[];
}
export function getOffer(id: string): OfferRow {
  const o = getDb().prepare("SELECT * FROM offers WHERE id = ?").get(id) as OfferRow | undefined;
  if (!o) throw new AppError("NOT_FOUND", "Offer not found", 404);
  return o;
}

/** Discovered programs are never auto-promoted: they start DISCOVERED / NOT_APPLIED with UNVERIFIED facts. */
export function addProgram(
  brandId: string,
  i: { name: string; network?: string; url?: string; notes?: string; legacy?: boolean },
  actor: string,
): string {
  assert(i.name.trim().length > 1, "BAD_INPUT", "Program name is required.");
  if (i.url) assert(validUrl(i.url), "BAD_URL", "Program URL must be http(s).");
  const id = newId("program");
  const now = nowIso();
  tx(() => {
    getDb()
      .prepare(
        `INSERT INTO programs (id, brand_id, name, network, url, program_status, account_status, notes, legacy, created_at, updated_at)
         VALUES (?,?,?,?,?, 'DISCOVERED', 'NOT_APPLIED', ?, ?, ?, ?)`,
      )
      .run(id, brandId, i.name.trim(), i.network ?? "", i.url ?? "", i.notes ?? "", i.legacy ? 1 : 0, now, now);
    for (const c of COMMERCIAL_CRITERIA) {
      getDb()
        .prepare("INSERT INTO commercial_facts (id, program_id, criterion, status, updated_at) VALUES (?,?,?, 'UNVERIFIED', ?)")
        .run(newId("fact"), id, c, now);
    }
  });
  audit({ actor, action: "program.add", subjectType: "program", subjectId: id, brandId, summary: `Program “${i.name.trim()}” recorded as DISCOVERED` });
  return id;
}

export function setFact(
  programId: string,
  criterion: string,
  i: { value: string; sourceUrl?: string; checkedAt?: string; evidence?: string; status: FactStatus },
  actor: string,
) {
  assert((COMMERCIAL_CRITERIA as readonly string[]).includes(criterion), "BAD_CRITERION", `Unknown criterion ${criterion}`);
  assert(FACT_STATUSES.includes(i.status), "BAD_STATUS", "Unknown fact status");
  if (i.status === "VERIFIED") {
    assert(i.sourceUrl && validUrl(i.sourceUrl), "EVIDENCE_REQUIRED", "A VERIFIED fact needs a source URL.");
    assert(i.checkedAt && !isNaN(Date.parse(i.checkedAt)), "EVIDENCE_REQUIRED", "A VERIFIED fact needs the date it was checked.");
    assert((i.evidence ?? "").trim().length >= 10, "EVIDENCE_REQUIRED", "A VERIFIED fact needs the supporting evidence text.");
  }
  const p = getProgram(programId);
  getDb()
    .prepare(
      `INSERT INTO commercial_facts (id, program_id, criterion, value, source_url, checked_at, evidence, status, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(program_id, criterion) DO UPDATE SET value=excluded.value, source_url=excluded.source_url, checked_at=excluded.checked_at,
         evidence=excluded.evidence, status=excluded.status, updated_at=excluded.updated_at`,
    )
    .run(newId("fact"), programId, criterion, i.value, i.sourceUrl ?? null, i.checkedAt ? new Date(i.checkedAt).toISOString() : null, i.evidence ?? "", i.status, nowIso());
  // Any fact change on a qualified program demotes it until re-qualified.
  if (p.program_status === "QUALIFIED" && i.status !== "VERIFIED" && i.status !== "NOT_APPLICABLE") {
    demoteProgram(programId, `Fact ${criterion} changed to ${i.status}`, actor);
  }
  audit({ actor, action: "fact.set", subjectType: "program", subjectId: programId, brandId: p.brand_id, summary: `${p.name}: ${criterion} → ${i.status}` });
}

export function qualificationGaps(programId: string): string[] {
  const facts = listFacts(programId);
  const gaps: string[] = [];
  for (const c of COMMERCIAL_CRITERIA) {
    const f = facts.find((x) => x.criterion === c);
    if (!f) gaps.push(`${c}: missing`);
    else if (f.status === "BLOCKED") gaps.push(`${c}: BLOCKED`);
    else if (f.status === "UNVERIFIED") gaps.push(`${c}: unverified`);
    else if (f.status === "VERIFIED" && (!f.source_url || !f.checked_at)) gaps.push(`${c}: missing source or date`);
  }
  return gaps;
}

export function qualifyProgram(programId: string, actor: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator qualifies programs.", 403);
  const gaps = qualificationGaps(programId);
  if (gaps.length) throw new AppError("NOT_QUALIFIABLE", `Cannot qualify: ${gaps.join("; ")}`, 409, gaps);
  const p = getProgram(programId);
  getDb().prepare("UPDATE programs SET program_status='QUALIFIED', updated_at=? WHERE id=?").run(nowIso(), programId);
  audit({ actor, action: "program.qualify", subjectType: "program", subjectId: programId, brandId: p.brand_id, summary: `${p.name} qualified (12/12 criteria evidenced)` });
}

function demoteProgram(programId: string, reason: string, actor: string) {
  const p = getProgram(programId);
  tx(() => {
    getDb().prepare("UPDATE programs SET program_status='DISCOVERED', updated_at=? WHERE id=?").run(nowIso(), programId);
    getDb().prepare("UPDATE offers SET link_status='INACTIVE', updated_at=? WHERE program_id=?").run(nowIso(), programId);
  });
  audit({ actor, action: "program.demote", subjectType: "program", subjectId: programId, brandId: p.brand_id, summary: `${p.name} demoted: ${reason}. Live links deactivated.`, level: "WARN" });
}

export function setProgramStatus(programId: string, status: "DISQUALIFIED" | "RETIRED" | "DISCOVERED", actor: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator changes program status.", 403);
  const p = getProgram(programId);
  if (status === "DISCOVERED") return demoteProgram(programId, "set by operator", actor);
  tx(() => {
    getDb().prepare("UPDATE programs SET program_status=?, updated_at=? WHERE id=?").run(status, nowIso(), programId);
    getDb().prepare("UPDATE offers SET link_status='INACTIVE', updated_at=? WHERE program_id=?").run(nowIso(), programId);
  });
  audit({ actor, action: "program.status", subjectType: "program", subjectId: programId, brandId: p.brand_id, summary: `${p.name} → ${status}` });
}

/**
 * Account status is recorded by the operator. Applying to a program or accepting its terms is
 * a Level 4 human action done outside this app; the app only records the outcome.
 */
export function setAccountStatus(programId: string, status: ProgramRow["account_status"], actor: string, note = "") {
  if (actor !== "operator") throw new AppError("PERMISSION", "Account status is recorded by the operator only (Level 4).", 403);
  const p = getProgram(programId);
  tx(() => {
    getDb().prepare("UPDATE programs SET account_status=?, updated_at=? WHERE id=?").run(status, nowIso(), programId);
    if (status !== "APPROVED") getDb().prepare("UPDATE offers SET link_status='INACTIVE', updated_at=? WHERE program_id=?").run(nowIso(), programId);
    getDb()
      .prepare(`INSERT INTO approvals (id, subject_type, subject_id, decision, status, level, actor, note, created_at) VALUES (?, 'program_account', ?, 'APPROVED', 'ACTIVE', 4, ?, ?, ?)`)
      .run(newId("approval"), programId, actor, `Account status recorded: ${status}. ${note}`.trim(), nowIso());
  });
  audit({ actor, action: "program.account", subjectType: "program", subjectId: programId, brandId: p.brand_id, summary: `${p.name}: account ${status}` });
}

export function addOffer(
  brandId: string,
  i: { programId: string; name: string; productUrl?: string; affiliateUrl?: string; disclosure?: string; commissionText?: string },
  actor: string,
): string {
  const p = getProgram(i.programId);
  assert(p.brand_id === brandId, "BAD_INPUT", "Program belongs to another brand.");
  assert(i.name.trim().length > 1, "BAD_INPUT", "Offer name is required.");
  for (const u of [i.productUrl, i.affiliateUrl]) if (u) assert(validUrl(u), "BAD_URL", "Offer URLs must be http(s).");
  const id = newId("offer");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO offers (id, brand_id, program_id, name, product_url, affiliate_url, disclosure, offer_status, link_status, commission_text, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'DRAFT', 'INACTIVE', ?, ?, ?)`,
    )
    .run(id, brandId, i.programId, i.name.trim(), i.productUrl ?? "", i.affiliateUrl ?? "", i.disclosure ?? "", i.commissionText ?? "", now, now);
  audit({ actor, action: "offer.add", subjectType: "offer", subjectId: id, brandId, summary: `Offer “${i.name.trim()}” added (DRAFT, link inactive)` });
  return id;
}

export function updateOffer(id: string, patch: Partial<Pick<OfferRow, "name" | "product_url" | "affiliate_url" | "disclosure" | "commission_text">>, actor: string) {
  const o = getOffer(id);
  for (const u of [patch.product_url, patch.affiliate_url]) if (u) assert(validUrl(u), "BAD_URL", "Offer URLs must be http(s).");
  const material = (patch.affiliate_url !== undefined && patch.affiliate_url !== o.affiliate_url) || (patch.disclosure !== undefined && patch.disclosure !== o.disclosure);
  getDb()
    .prepare("UPDATE offers SET name=?, product_url=?, affiliate_url=?, disclosure=?, commission_text=?, link_status=?, updated_at=? WHERE id=?")
    .run(
      patch.name ?? o.name,
      patch.product_url ?? o.product_url,
      patch.affiliate_url ?? o.affiliate_url,
      patch.disclosure ?? o.disclosure,
      patch.commission_text ?? o.commission_text,
      material ? "INACTIVE" : o.link_status,
      nowIso(),
      id,
    );
  audit({ actor, action: "offer.update", subjectType: "offer", subjectId: id, brandId: o.brand_id, summary: `Offer ${o.name} updated${material ? " — link deactivated pending review" : ""}` });
}

export function setOfferValidity(id: string, status: OfferRow["offer_status"], actor: string) {
  const o = getOffer(id);
  if (status === "VALID") assert(o.product_url && o.affiliate_url, "BAD_INPUT", "A valid offer needs product and affiliate URLs.");
  getDb()
    .prepare("UPDATE offers SET offer_status=?, checked_at=?, link_status=CASE WHEN ?='VALID' THEN link_status ELSE 'INACTIVE' END, updated_at=? WHERE id=?")
    .run(status, nowIso(), status, nowIso(), id);
  audit({ actor, action: "offer.validity", subjectType: "offer", subjectId: id, brandId: o.brand_id, summary: `Offer ${o.name} → ${status}` });
}

export function linkActivationGaps(offerId: string): string[] {
  const o = getOffer(offerId);
  const p = getProgram(o.program_id);
  const gaps: string[] = [];
  if (p.program_status !== "QUALIFIED") gaps.push(`Program is ${p.program_status}, not QUALIFIED.`);
  if (p.account_status !== "APPROVED") gaps.push(`Account is ${p.account_status}, not APPROVED.`);
  if (o.offer_status !== "VALID") gaps.push(`Offer is ${o.offer_status}, not VALID.`);
  if (!o.affiliate_url) gaps.push("No affiliate URL.");
  if (!o.disclosure.trim()) gaps.push("No disclosure text.");
  return gaps;
}

export function setLinkStatus(offerId: string, status: "ACTIVE" | "INACTIVE", actor: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator activates live links.", 403);
  const o = getOffer(offerId);
  if (status === "ACTIVE") {
    const gaps = linkActivationGaps(offerId);
    if (gaps.length) throw new AppError("LINK_BLOCKED", gaps.join(" "), 409, gaps);
  }
  getDb().prepare("UPDATE offers SET link_status=?, updated_at=? WHERE id=?").run(status, nowIso(), offerId);
  audit({ actor, action: "offer.link", subjectType: "offer", subjectId: offerId, brandId: o.brand_id, summary: `Offer ${o.name} live link ${status}` });
}

/** Hash of the commercial configuration an approval is bound to. */
export function commercialHash(item: { commercial_decision: string; target_offer_id: string | null }): string {
  let offer: Partial<OfferRow> | null = null;
  if (item.target_offer_id) {
    const o = getDb().prepare("SELECT * FROM offers WHERE id = ?").get(item.target_offer_id) as OfferRow | undefined;
    offer = o ? { id: o.id, affiliate_url: o.affiliate_url, disclosure: o.disclosure, program_id: o.program_id } : { id: item.target_offer_id };
  }
  return sha256(stableStringify({ decision: item.commercial_decision, offer })).slice(0, 24);
}

export function commercialReadiness(item: { commercial_decision: string; target_offer_id: string | null }): { ok: boolean; reasons: string[] } {
  if (item.commercial_decision === "NO_OFFER") return { ok: true, reasons: [] };
  if (item.commercial_decision === "UNDECIDED") return { ok: false, reasons: ["Choose a target offer or record NO_OFFER."] };
  if (!item.target_offer_id) return { ok: false, reasons: ["No target offer selected."] };
  const o = getDb().prepare("SELECT * FROM offers WHERE id = ?").get(item.target_offer_id) as OfferRow | undefined;
  if (!o) return { ok: false, reasons: ["Target offer no longer exists."] };
  const gaps = linkActivationGaps(o.id);
  if (o.link_status !== "ACTIVE") gaps.push("Live link is not active.");
  return { ok: gaps.length === 0, reasons: gaps };
}

export function monetizationSummary(brandId: string) {
  const programs = listPrograms(brandId);
  const offers = listOffers(brandId);
  return {
    discovered: programs.filter((p) => p.program_status !== "RETIRED").length,
    qualified: programs.filter((p) => p.program_status === "QUALIFIED").length,
    accountsApproved: programs.filter((p) => p.account_status === "APPROVED").length,
    activeOffers: offers.filter((o) => o.link_status === "ACTIVE").length,
  };
}
