import fs from "node:fs";
import { importBundle } from "@/core/portability";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Usage: npm run import -- <data.json> [--apply] [--legacy]\nDefault is a dry run. --legacy imports approvals/QA/jobs as unverified history.");
  process.exit(1);
}
const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
const r = importBundle(bundle, { dryRun: !args.includes("--apply"), asLegacy: args.includes("--legacy"), actor: "cli" });
console.log(JSON.stringify(r, null, 2));
if (!r.ok) process.exit(2);
