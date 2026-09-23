import { NextResponse } from "next/server";
import { exportContent } from "@/core/content";
import { AppError } from "@/core/util";
import { requireOperator } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await ctx.params;
    return new NextResponse(JSON.stringify(exportContent(id), null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${id}.json"` },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof AppError ? e.status : 500 });
  }
}
