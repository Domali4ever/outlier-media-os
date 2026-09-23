import { NextResponse } from "next/server";
import { audit } from "@/core/audit";
import { exportAll } from "@/core/portability";
import { AppError } from "@/core/util";
import { requireOperator } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Downloads the versioned JSON export (credentials excluded). Assets are included by `npm run export`/backup. */
export async function GET() {
  try {
    const actor = await requireOperator();
    const bundle = exportAll();
    audit({ actor, action: "data.export_download", subjectType: "system", subjectId: "export", summary: "JSON export downloaded" });
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="omos-export-${bundle.exported_at.slice(0, 10)}.json"` },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof AppError ? e.status : 500 });
  }
}
