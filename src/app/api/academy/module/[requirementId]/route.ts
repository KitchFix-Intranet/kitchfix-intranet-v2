// /api/academy/module/[requirementId]
//
// Thin wrapper over loadModule(email, requirementId). See
// src/lib/academy/module.ts for the full shape, security notes,
// and step-boundary logic.

import { NextResponse } from "next/server";
import { requireAppAccessApi } from "@/lib/gate";
import { loadModule } from "@/lib/academy/module";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ requirementId: string }> }
) {
  const g = await requireAppAccessApi("/academy/read");
  if (g instanceof Response) return g;

  const params = await ctx.params;
  const result = await loadModule(g.email, params.requirementId);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(result);
}
