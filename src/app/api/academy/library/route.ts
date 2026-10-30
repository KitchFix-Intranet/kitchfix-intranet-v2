// /api/academy/library
//
// Thin wrapper over loadLibrary(email). See src/lib/academy/library.ts.

import { NextResponse } from "next/server";
import { requireAppAccessApi } from "@/lib/gate";
import { loadLibrary } from "@/lib/academy/library";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await requireAppAccessApi("/library");
  if (g instanceof Response) return g;

  const result = await loadLibrary(g.email);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(result);
}
