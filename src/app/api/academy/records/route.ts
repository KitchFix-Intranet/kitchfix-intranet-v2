// /api/academy/records
//
// Thin wrapper over loadRecords(email). See src/lib/academy/records.ts.

import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { loadRecords } from "@/lib/academy/records";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  const result = await loadRecords(g.email);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(result);
}
