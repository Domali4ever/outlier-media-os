import fs from "node:fs";
import path from "node:path";
import type { JobRow } from "@/core/jobs";
import { heartbeat, recordUsage, setSideEffect } from "@/core/jobs";
import { addCost } from "@/core/performance";
import { getSecret } from "@/core/settings";
import type { Usage } from "@/adapters/anthropic";

export class JobContext {
  constructor(public job: JobRow, public workerId: string) {}
  input<T>(): T {
    return JSON.parse(this.job.input_json) as T;
  }
  progress(text: string) {
    if (!heartbeat(this.job.id, this.workerId, text)) throw new LeaseLost();
  }
  sideEffect(s: "REQUESTED" | "CONFIRMED") {
    setSideEffect(this.job.id, this.workerId, s);
  }
  /** Records token usage and an ESTIMATED cost (never presented as measured). */
  usage(u: Usage, cost: number | null, model: string) {
    recordUsage(this.job.id, { ...u, model }, cost);
    if (cost !== null && this.job.brand_id) {
      const priceCur = getSecret("ANTHROPIC_PRICE_CURRENCY") || "USD";
      addCost({ brandId: this.job.brand_id, category: "ai", amount: cost, currency: priceCur, isEstimate: true, source: `anthropic:${model}`, jobId: this.job.id, note: `${u.input_tokens} in / ${u.output_tokens} out tokens` });
    }
  }
}

export class LeaseLost extends Error {
  constructor() {
    super("Worker lease lost (job cancelled or reclaimed)");
  }
}

const promptCache = new Map<string, string>();
export function prompt(name: string): string {
  if (!promptCache.has(name)) {
    const root = process.env.OMOS_ROOT || /*turbopackIgnore: true*/ process.cwd();
    promptCache.set(name, fs.readFileSync(path.join(root, "prompts", `${name}.md`), "utf8"));
  }
  return promptCache.get(name)!;
}
