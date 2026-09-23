import { NextResponse } from "next/server";
import { getJob, jobEvents } from "@/core/jobs";
import { AppError, parseJson } from "@/core/util";
import { requireOperator } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await ctx.params;
    const j = getJob(id);
    return NextResponse.json({
      id: j.id,
      type: j.type,
      state: j.state,
      progress: j.progress_text,
      blocked: parseJson<string[]>(j.blocked_reason_json, []),
      error: parseJson<{ message?: string } | null>(j.error_json, null)?.message ?? null,
      output: parseJson(j.output_json, null),
      events: jobEvents(id).slice(-20).map((e) => ({ at: e.at, state: e.state, message: e.message })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof AppError ? e.status : 500 });
  }
}
