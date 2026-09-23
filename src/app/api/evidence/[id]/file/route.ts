import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { assetsDir, getDb } from "@/core/db";
import { AppError } from "@/core/util";
import { requireOperator } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await ctx.params;
    const e = getDb().prepare("SELECT file_path FROM evidence WHERE id = ?").get(id) as { file_path: string | null } | undefined;
    if (!e?.file_path) throw new AppError("NOT_FOUND", "No file for this evidence.", 404);
    const root = path.resolve(assetsDir());
    const full = path.resolve(root, e.file_path);
    if (!full.startsWith(root + path.sep)) throw new AppError("FORBIDDEN", "Bad path.", 403);
    const data = fs.readFileSync(full);
    return new NextResponse(data, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${path.basename(full)}"`, "x-content-type-options": "nosniff" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof AppError ? e.status : 500 });
  }
}
