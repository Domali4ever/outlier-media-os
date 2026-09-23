import { getDb } from "./db";
import { brandSettings, getBrand, getAvatars } from "./brand";
import { HIGH_RISK_CLAIMS } from "./types";
import { newId, nowIso, parseJson } from "./util";

export interface QaFinding {
  check: string;
  severity: "FAIL" | "WARN" | "PASS";
  message: string;
}

export interface QaReportRow {
  id: string;
  content_id: string;
  revision_id: string;
  kind: "DETERMINISTIC" | "AI_EDITORIAL" | "HUMAN_REVIEW";
  result: "PASS" | "FAIL" | "WARN";
  findings_json: string;
  job_id: string | null;
  reviewer: string;
  created_at: string;
}

/**
 * Deterministic, structural QA. A PASS here means the structure and recorded evidence meet
 * the rules. It does NOT mean factual, medical or editorial review passed.
 */
export function runDeterministicQa(contentId: string): { result: "PASS" | "FAIL" | "WARN"; findings: QaFinding[]; revisionId: string } {
  const db = getDb();
  const item = db.prepare("SELECT * FROM content_items WHERE id = ?").get(contentId) as {
    id: string; brand_id: string; current_revision_id: string; commercial_decision: string; target_offer_id: string | null; risk: string;
  };
  const rev = db.prepare("SELECT * FROM content_revisions WHERE id = ?").get(item.current_revision_id) as { id: string; title: string; body: string };
  const brand = getBrand(item.brand_id);
  const s = brandSettings(brand);
  const body = rev.body ?? "";
  const lower = body.toLowerCase();
  const f: QaFinding[] = [];
  const add = (check: string, ok: boolean, message: string, severity: "FAIL" | "WARN" = "FAIL") =>
    f.push({ check, severity: ok ? "PASS" : severity, message: ok ? "OK" : message });

  add("title", rev.title.trim().length >= 10 && rev.title.trim().length <= 120, "Title must be 10–120 characters.");
  add("length", body.trim().length >= s.minBodyChars, `Body is ${body.trim().length} characters; minimum is ${s.minBodyChars}.`);
  const placeholder = /\[[A-Z][A-Z0-9 _\-/]{2,}\](?!\()/.test(body) || /\b(TODO|TBD|TK)\b/.test(body) || /lorem ipsum/i.test(body);
  add("placeholders", !placeholder, "Body contains placeholders (e.g. [PRICE], TODO, TBD, lorem ipsum).");
  const hits = s.restrictedPhrases.filter((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body));
  add("restricted_phrases", hits.length === 0, `Restricted phrases present: ${hits.join(", ")}.`);

  const avatars = getAvatars(item.brand_id);
  if (s.aiDisclosureRequired) {
    const disclosure = avatars[0]?.ai_disclosure ?? "";
    const hasAiDisclosure = /\b(ai|artificial intelligence)[- ](generated|assisted|created|written)\b|written with (the help of )?ai|produced with ai/i.test(body) || (!!disclosure && lower.includes(disclosure.toLowerCase().slice(0, 40)));
    add("ai_disclosure", hasAiDisclosure, "No AI disclosure found in the body.");
  }
  const restricted = avatars.flatMap((a) => parseJson<string[]>(a.restricted_claims_json, []));
  const firstPerson = /\b(i|we) (have )?(use|used|tested|tried|own|slept with)\b|\bmy (cpap|machine|mask)\b/i.test(body);
  add("no_personal_use", !firstPerson, "Body claims personal product use or experience, which the avatar must not claim.");
  if (restricted.length) {
    f.push({ check: "restricted_claims_listed", severity: "PASS", message: `${restricted.length} restricted claim categories apply (checked in editorial review).` });
  }

  const hasAffLink = item.commercial_decision === "OFFER";
  if (hasAffLink) {
    const offer = item.target_offer_id
      ? (db.prepare("SELECT disclosure FROM offers WHERE id = ?").get(item.target_offer_id) as { disclosure: string } | undefined)
      : undefined;
    const needle = (offer?.disclosure || s.affiliateDisclosure).toLowerCase().slice(0, 30);
    add("affiliate_disclosure", lower.includes(needle) || /affiliate link/i.test(body), "Affiliate content must include the disclosure text.");
  } else if (item.commercial_decision === "NO_OFFER") {
    add("no_affiliate_links", !/[?&](tag|aff|affid|ref|irgwc|clickid)=/i.test(body), "NO_OFFER content contains what looks like an affiliate link.");
  }

  const links = [...body.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0]);
  const badLinks = links.filter((l) => {
    try {
      new URL(l);
      return false;
    } catch {
      return true;
    }
  });
  add("links_wellformed", badLinks.length === 0, `Malformed links: ${badLinks.join(", ")}`);

  const ev = db
    .prepare("SELECT COUNT(*) n FROM evidence WHERE content_id = ? AND kind IN ('WEB_SOURCE','DOCUMENT','DRIVE_DOCUMENT','MANUAL_NOTE') AND checked_at IS NOT NULL")
    .get(contentId) as { n: number };
  add("evidence_attached", ev.n >= 1, "No dated evidence is attached.");

  const maxAge = s.evidenceMaxAgeDays * 86400_000;
  const claims = db.prepare("SELECT c.*, e.checked_at ev_checked, e.url ev_url FROM claims c LEFT JOIN evidence e ON e.id = c.evidence_id WHERE c.content_id = ?").all(contentId) as {
    text: string; claim_type: string; status: string; ev_checked: string | null; ev_url: string | null;
  }[];
  for (const c of claims) {
    const high = (HIGH_RISK_CLAIMS as string[]).includes(c.claim_type);
    if (c.status === "BLOCKED") f.push({ check: "claim", severity: "FAIL", message: `BLOCKED ${c.claim_type} claim: “${c.text}”` });
    else if (c.status === "UNVERIFIED") f.push({ check: "claim", severity: high ? "FAIL" : "WARN", message: `Unverified ${c.claim_type} claim: “${c.text}”` });
    else if (c.status === "VERIFIED" && high) {
      const stale = !c.ev_checked || Date.now() - new Date(c.ev_checked).getTime() > maxAge;
      if (stale || !c.ev_url) f.push({ check: "claim", severity: "FAIL", message: `${c.claim_type} claim lacks a dated source within ${s.evidenceMaxAgeDays} days: “${c.text}”` });
    }
  }
  if (item.risk === "BLOCKED") f.push({ check: "risk", severity: "FAIL", message: "Item risk is BLOCKED." });

  const result = f.some((x) => x.severity === "FAIL") ? "FAIL" : f.some((x) => x.severity === "WARN") ? "WARN" : "PASS";
  return { result, findings: f, revisionId: rev.id };
}

export function saveQaReport(i: {
  contentId: string;
  revisionId: string;
  kind: QaReportRow["kind"];
  result: QaReportRow["result"];
  findings: QaFinding[] | unknown;
  jobId?: string | null;
  reviewer: string;
}): string {
  const id = newId("qa");
  getDb()
    .prepare("INSERT INTO qa_reports (id, content_id, revision_id, kind, result, findings_json, job_id, reviewer, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, i.contentId, i.revisionId, i.kind, i.result, JSON.stringify(i.findings), i.jobId ?? null, i.reviewer, nowIso());
  return id;
}

export function latestQa(contentId: string, revisionId: string, kind: QaReportRow["kind"]): QaReportRow | undefined {
  return getDb()
    .prepare("SELECT * FROM qa_reports WHERE content_id = ? AND revision_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1")
    .get(contentId, revisionId, kind) as QaReportRow | undefined;
}

export function listQa(contentId: string): QaReportRow[] {
  return getDb().prepare("SELECT * FROM qa_reports WHERE content_id = ? ORDER BY created_at DESC").all(contentId) as QaReportRow[];
}
