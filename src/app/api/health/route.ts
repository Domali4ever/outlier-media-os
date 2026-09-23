import { NextResponse } from "next/server";
import { currentSchemaVersion } from "@/core/db";
import { workerStatus } from "@/core/jobs";
import { boot } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Unauthenticated liveness probe; exposes no business data. */
export async function GET() {
  boot();
  const w = workerStatus();
  return NextResponse.json({ ok: true, schema: currentSchemaVersion(), worker: w.alive ? "alive" : "not_running" });
}
