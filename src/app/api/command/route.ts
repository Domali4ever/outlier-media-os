import { NextResponse } from "next/server";
import { dispatch, dispatchStructured } from "@/core/commands";
import { selectedBrandId } from "@/core/brand";
import { AppError } from "@/core/util";
import { assertSameOrigin, requireOperator } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const actor = await requireOperator();
    await assertSameOrigin();
    const body = (await req.json()) as { input?: string; confirmed?: boolean };
    const input = String(body.input ?? "").slice(0, 1000);
    const brandId = selectedBrandId();
    // A confirmed command must be a structured command; it is dispatched deterministically.
    if (body.confirmed) {
      const r = dispatchStructured(input, actor, brandId);
      return NextResponse.json(r ?? { kind: "error", message: "Not a structured command.", suggestions: [] });
    }
    return NextResponse.json(await dispatch(input, actor, brandId));
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500;
    return NextResponse.json({ kind: "error", message: (e as Error).message, suggestions: [] }, { status });
  }
}
