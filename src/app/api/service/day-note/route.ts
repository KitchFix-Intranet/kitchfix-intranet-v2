// Day-note route (train 4).
//
// GET  /api/service/day-note?account=<key>&date=<ISO>
//      -> the fold payload (newest-first grouped history + notes).
//      Owner-only in this train; canWriteForAccount runs so a staff
//      viewer gets the same scope rule the day form uses.
//
// POST /api/service/day-note  { accountKey, serviceDate, note }
//      -> inserts one row into sc_day_note_entries. No period or
//      week lock (sc-25 header: "Notes stay open on a locked
//      period"; sc-9 table has no DELETE grant). The author is
//      server-derived from the signed-in session; the client cannot
//      spoof it. Returns the fresh loader payload so the client can
//      drop its optimistic entry.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { canWriteForAccount } from "@/lib/sc/access/canWriteForAccount";
import { loadNotesHistory } from "@/lib/sc/notesHistory/load";
import type { ViewerLite } from "@/lib/sc/calendar/types";

export const dynamic = "force-dynamic";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const url = new URL(req.url);
  const accountKey = url.searchParams.get("account");
  const serviceDate = url.searchParams.get("date");
  if (!accountKey || !serviceDate || !ISO_RE.test(serviceDate)) {
    return NextResponse.json(
      { ok: false, code: "SERVER_ERROR", message: "account and date (YYYY-MM-DD) required" },
      { status: 400 },
    );
  }
  const sb = serviceClient();
  const scope = await scopeCheck(sb, gate.email, accountKey);
  if (scope instanceof Response) return scope;
  try {
    const view = await loadNotesHistory({ sb, accountKey, serviceDate });
    return NextResponse.json({ ok: true, view });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message }, { status: 500 });
  }
}

interface PostBody {
  accountKey?: unknown;
  serviceDate?: unknown;
  note?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const email = gate.email;

  let body: PostBody;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "Invalid JSON" }, { status: 400 });
  }
  const accountKey = typeof body.accountKey === "string" ? body.accountKey : null;
  const serviceDate = typeof body.serviceDate === "string" ? body.serviceDate : null;
  const noteRaw = typeof body.note === "string" ? body.note : "";
  const note = noteRaw.trim();

  if (!accountKey) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "accountKey required" }, { status: 400 });
  if (!serviceDate || !ISO_RE.test(serviceDate)) {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "serviceDate must be YYYY-MM-DD" }, { status: 400 });
  }
  if (!note) return NextResponse.json({ ok: false, code: "EMPTY_NOTE", message: "A note cannot be empty." }, { status: 400 });
  if (note.length > 2000) {
    return NextResponse.json({ ok: false, code: "TOO_LONG", message: "A note is at most 2000 characters." }, { status: 400 });
  }

  const sb = serviceClient();
  const scope = await scopeCheck(sb, email, accountKey);
  if (scope instanceof Response) return scope;

  const { error: insErr } = await sb.from("sc_day_note_entries").insert({
    account_key: accountKey,
    service_date: serviceDate,
    note,
    author: email,
    source: null,
  });
  if (insErr) {
    return NextResponse.json({ ok: false, code: "WRITE_FAILED", message: insErr.message }, { status: 500 });
  }

  try {
    const view = await loadNotesHistory({ sb, accountKey, serviceDate });
    return NextResponse.json({ ok: true, view });
  } catch (e) {
    // The write landed; return 200 with no view so the client can
    // reload. Message surfaces in logs.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[day-note] loadNotesHistory after insert: ${message}`);
    return NextResponse.json({ ok: true, view: null });
  }
}

async function scopeCheck(
  sb: SupabaseClient,
  email: string,
  accountKey: string,
): Promise<Response | { viewer: ViewerLite }> {
  const { viewer } = await resolveViewer(sb, email, null, true);
  if (!viewer) {
    return NextResponse.json({ ok: false, code: "NOT_AUTHORIZED", message: "Viewer not on the roster." }, { status: 403 });
  }
  const lite: ViewerLite = {
    worker_id: viewer.worker_id,
    display_name: viewer.display_name,
    role: viewer.role,
    is_corp: !!viewer.is_corp,
    is_regional_director: !!viewer.is_regional_director,
    is_salaried: !!viewer.is_salaried,
    region: viewer.region,
    account_key: viewer.account_key,
    previewOf: viewer.previewOf,
  };
  const can = canWriteForAccount(lite, accountKey);
  if (!can.ok) return NextResponse.json(can, { status: 403 });
  return { viewer: lite };
}
