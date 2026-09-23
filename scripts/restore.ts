import path from "node:path";
import { restoreFrom } from "@/core/portability";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npm run restore -- <path-to-backup-directory>\nStop the app and worker first.");
  process.exit(1);
}
const r = restoreFrom(path.resolve(dir));
console.log(`Restored from ${dir}. Previous database kept at ${r.safetyCopy}. Start the app again with npm start.`);
