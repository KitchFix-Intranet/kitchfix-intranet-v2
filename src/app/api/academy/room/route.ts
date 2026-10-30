// /api/academy/room
//
// Thin wrapper over loadRoom(email). See src/lib/academy/room.ts for
// the full shape and the design notes.

import { NextResponse } from "next/server";
import { requireAppAccessApi } from "@/lib/gate";
import { loadRoom } from "@/lib/academy/room";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await requireAppAccessApi("/academy");
  if (g instanceof Response) return g;

  const result = await loadRoom(g.email);
  if (!result.ok) {
    const { status, ...body } = result;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(result);
}
