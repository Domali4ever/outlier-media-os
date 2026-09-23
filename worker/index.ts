/**
 * Durable worker process. Runs independently of the browser: jobs continue when tabs close.
 * It must keep running (with the host awake) for jobs to execute — it does not run while the
 * computer sleeps or is off. Start with `npm run worker` (or `npm start`, which starts both).
 */
import os from "node:os";
import { getDb } from "@/core/db";
import { audit } from "@/core/audit";
import { claimNext, recoverExpiredLeases, reevaluateBlocked } from "@/core/jobs";
import { scheduleRecurring } from "@/core/automation";
import { seedIfEmpty } from "@/core/seed";
import { setSetting } from "@/core/settings";
import { executeJob } from "@/modules";

const workerId = `worker_${os.hostname().replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}_${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 2000);
const SCHEDULE_MS = 15 * 60 * 1000;
let stopping = false;
let busy = false;
let lastSchedule = 0;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${workerId} ${msg}`);
}

async function tick() {
  setSetting("worker_heartbeat", { workerId, pid: process.pid });
  const recovered = recoverExpiredLeases();
  if (recovered) log(`recovered ${recovered} expired lease(s)`);
  const released = reevaluateBlocked();
  if (released) log(`released ${released} blocked job(s)`);
  if (Date.now() - lastSchedule > SCHEDULE_MS) {
    lastSchedule = Date.now();
    const s = scheduleRecurring();
    if (s.length) log(`scheduled ${s.length} recurring job(s)`);
  }
  while (!stopping) {
    const job = claimNext(workerId);
    if (!job) break;
    busy = true;
    log(`running ${job.id} ${job.type} (attempt ${job.attempts})`);
    try {
      const state = await executeJob(job, workerId);
      log(`${job.id} → ${state}`);
    } finally {
      busy = false;
    }
  }
}

async function main() {
  getDb();
  seedIfEmpty();
  audit({ actor: "worker", action: "worker.start", subjectType: "worker", subjectId: workerId, summary: `Worker ${workerId} started` });
  log(`started (poll ${POLL_MS} ms)`);
  while (!stopping) {
    try {
      await tick();
    } catch (e) {
      log(`tick error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log(`${sig} received — finishing current job before exit`);
  const wait = setInterval(() => {
    if (!busy) {
      clearInterval(wait);
      try {
        audit({ actor: "worker", action: "worker.stop", subjectType: "worker", subjectId: workerId, summary: `Worker ${workerId} stopped (${sig})` });
      } catch {
        /* db may be closing */
      }
      process.exit(0);
    }
  }, 200);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
