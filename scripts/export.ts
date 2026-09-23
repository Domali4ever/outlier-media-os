import { exportToDir } from "@/core/portability";

const r = exportToDir("cli");
console.log(`Export written to ${r.dir} (data.json + assets/). Credentials are not included.`);
