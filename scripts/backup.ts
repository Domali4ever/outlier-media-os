import { backupNow } from "@/core/portability";

backupNow("cli").then((r) => console.log(`Backup written to ${r.dir}`));
