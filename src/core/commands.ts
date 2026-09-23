import { z } from "zod";
import { getDb } from "./db";
import { audit } from "./audit";
import { getContent, listContent } from "./content";
import { isCapabilityReady } from "./integrations";
import { createJob, JOB_TYPES, listJobs, pricingBlockReason } from "./jobs";
import { budgetBlockReason } from "./policies";
import { pausedJobTypes, setSetting } from "./settings";
import { recordCheckIn } from "./today";
import { CAP } from "./types";
import { AppError } from "./util";

export type CommandResult =
  | { kind: "navigate"; href: string; message: string }
  | { kind: "list"; title: string; items: { label: string; href: string; detail?: string }[] }
  | { kind: "done"; message: string; href?: string }
  | { kind: "confirm"; message: string; command: string }
  | { kind: "error"; message: string; suggestions: string[] };

export const STRUCTURED_COMMANDS = [
  "show approvals",
  "show failed jobs",
  "show blocked jobs",
  "open <id>",
  "search <text>",
  "pause workflow <JOB_TYPE>",
  "resume workflow <JOB_TYPE>",
  "pause all",
  "resume all",
  "run qa <content_id>",
  "generate research <content_id>",
  "generate script <content_id>",
  "check in",
  "help",
];

const PAUSABLE = Object.keys(JOB_TYPES);

function hrefFor(id: string): string | null {
  if (id.startsWith("content_")) return `/pipeline/${id}`;
  if (id.startsWith("job_")) return `/system?job=${id}#jobs`;
  if (id.startsWith("program_") || id.startsWith("offer_") || id.startsWith("avatar_") || id.startsWith("brand_")) return `/brand#monetization`;
  if (id.startsWith("rec_")) return `/`;
  return null;
}

/** Deterministic dispatcher: works without AI. Every mutating path goes through the same guarded services. */
export function dispatchStructured(raw: string, actor: string, brandId: string): CommandResult | null {
  const input = raw.trim().replace(/\s+/g, " ");
  const lower = input.toLowerCase();
  if (lower === "help" || lower === "?") return { kind: "list", title: "Commands", items: STRUCTURED_COMMANDS.map((c) => ({ label: c, href: "#" })) };
  if (lower === "show approvals") {
    const items = listContent(brandId).filter((c) => c.stage === "APPROVAL" || c.approval === "PENDING");
    return { kind: "list", title: `Awaiting approval · ${items.length}`, items: items.map((c) => ({ label: c.title, href: `/pipeline/${c.id}`, detail: `${c.id} · ${c.stage} · ${c.approval}` })) };
  }
  if (lower === "show failed jobs" || lower === "show blocked jobs") {
    const states = lower.includes("failed") ? (["FAILED", "NEEDS_ATTENTION"] as const) : (["BLOCKED"] as const);
    const jobs = listJobs({ states: [...states], brandId, limit: 50 });
    return { kind: "list", title: `${lower.includes("failed") ? "Failed / needs attention" : "Blocked"} jobs · ${jobs.length}`, items: jobs.map((j) => ({ label: `${j.id} · ${j.type}`, href: `/system?job=${j.id}#jobs`, detail: j.state })) };
  }
  let m = input.match(/^open (\S+)$/i);
  if (m) {
    const href = hrefFor(m[1]);
    if (!href) return { kind: "error", message: `Unknown ID format “${m[1]}”.`, suggestions: ["open content_idea_001", "open job_…"] };
    if (m[1].startsWith("content_")) getContent(m[1]);
    return { kind: "navigate", href, message: `Opening ${m[1]}` };
  }
  m = input.match(/^search (.+)$/i);
  if (m) return { kind: "navigate", href: `/pipeline?q=${encodeURIComponent(m[1])}`, message: `Searching for “${m[1]}”` };
  m = input.match(/^(pause|resume) workflow (\S+)$/i);
  if (m) {
    const t = m[2].toUpperCase();
    if (!PAUSABLE.includes(t)) return { kind: "error", message: `Unknown workflow ${t}.`, suggestions: PAUSABLE.map((p) => `${m![1].toLowerCase()} workflow ${p}`) };
    const set = new Set(pausedJobTypes());
    m[1].toLowerCase() === "pause" ? set.add(t) : set.delete(t);
    setSetting("paused_job_types", [...set]);
    audit({ actor, action: `workflow.${m[1].toLowerCase()}`, subjectType: "workflow", subjectId: t, brandId, summary: `Workflow ${t} ${m[1].toLowerCase()}d` });
    return { kind: "done", message: `Workflow ${t} ${m[1].toLowerCase()}d.` };
  }
  if (lower === "pause all" || lower === "resume all") {
    setSetting("system_paused", lower === "pause all");
    audit({ actor, action: lower === "pause all" ? "system.pause" : "system.resume", subjectType: "system", subjectId: "automation", brandId, summary: lower === "pause all" ? "All automation paused" : "Automation resumed" });
    return { kind: "done", message: lower === "pause all" ? "All automation paused. Running jobs finish; nothing new starts." : "Automation resumed." };
  }
  m = input.match(/^(run qa|generate research|generate script) (\S+)$/i);
  if (m) {
    const type = { "run qa": "QA_DETERMINISTIC", "generate research": "RESEARCH", "generate script": "SCRIPT" }[m[1].toLowerCase()]!;
    const c = getContent(m[2]);
    if (c.brand_id !== brandId) throw new AppError("BAD_INPUT", "That content belongs to another brand.");
    const { job, created } = createJob({ type, brandId, contentId: c.id, revisionId: c.current_revision_id, actor, rerun: true });
    return { kind: "done", message: `${JOB_TYPES[type].label}: job ${job.id} ${created ? "created" : "already exists"} — ${job.state}.`, href: `/system?job=${job.id}#jobs` };
  }
  if (lower === "check in") {
    recordCheckIn(actor);
    return { kind: "done", message: "Check-in recorded.", href: "/" };
  }
  return null;
}

const Interp = z.object({ command: z.string(), explanation: z.string() });

const MUTATING = /^(pause|resume|run qa|generate|check in)/i;

/** Natural language → one structured command via the AI adapter. The result is validated and re-dispatched. */
export async function dispatch(raw: string, actor: string, brandId: string): Promise<CommandResult> {
  if (!raw.trim()) return { kind: "error", message: "Type a command.", suggestions: STRUCTURED_COMMANDS };
  const direct = dispatchStructured(raw, actor, brandId);
  if (direct) return direct;
  if (!isCapabilityReady(CAP.AI)) return { kind: "error", message: "AI not connected — natural-language commands are unavailable. These structured commands work:", suggestions: STRUCTURED_COMMANDS };
  const block = budgetBlockReason(brandId) ?? pricingBlockReason(brandId);
  if (block) return { kind: "error", message: `AI command interpretation is blocked: ${block}`, suggestions: STRUCTURED_COMMANDS };
  const { structured } = await import("@/adapters/anthropic");
  const { prompt } = await import("@/modules/context");
  const r = await structured({
    system: prompt("command"),
    user: raw.slice(0, 1000),
    toolName: "console_command",
    toolDescription: "Return exactly one structured console command, written as it would be typed (e.g. 'run qa content_idea_001').",
    jsonSchema: { type: "object", properties: { command: { type: "string" }, explanation: { type: "string" } }, required: ["command", "explanation"] },
    schema: Interp,
    maxTokens: 300,
    timeoutMs: 30_000,
  });
  if (r.costEstimate !== null) {
    const { addCost } = await import("./performance");
    const { getSecret } = await import("./settings");
    addCost({ brandId, category: "ai", amount: r.costEstimate, currency: getSecret("ANTHROPIC_PRICE_CURRENCY") || "USD", isEstimate: true, source: `anthropic:${r.model}`, note: "command interpretation" });
  }
  // The model may write "pause_workflow PUBLISH": only the verb token gets underscores turned into spaces.
  const [head, ...rest] = r.value.command.trim().split(/\s+/);
  const normalized = [head.replace(/_/g, " "), ...rest].join(" ");
  if (MUTATING.test(normalized)) return { kind: "confirm", message: `Interpreted as “${normalized}”. ${r.value.explanation}`, command: normalized };
  const res = dispatchStructured(normalized, actor, brandId);
  return res ?? { kind: "error", message: `Could not map that to a command (${r.value.explanation}).`, suggestions: STRUCTURED_COMMANDS };
}

export function recentCommandsCount(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM audit_events WHERE action LIKE 'workflow.%'").get() as { n: number }).n;
}
