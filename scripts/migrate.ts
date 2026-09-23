import { currentSchemaVersion, dbPath, getDb } from "@/core/db";
import { seedIfEmpty } from "@/core/seed";

getDb();
const seeded = seedIfEmpty();
console.log(`Database: ${dbPath()}`);
console.log(`Schema version: ${currentSchemaVersion()}`);
console.log(seeded ? "Initialized brand_cpap_travel (DRAFT) with honest empty operational state." : "Existing data kept; nothing seeded.");
