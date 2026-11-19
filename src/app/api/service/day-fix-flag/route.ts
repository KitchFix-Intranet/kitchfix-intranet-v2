// Day fix-flag route (round 3: update-only, locks checked).
//
// POST   /api/service/day-fix-flag  { accountKey, iso }  -> marks the
//        day's review_status = 'flagged' on an EXISTING sc_day_metadata
//        row. checkWeekSubmittable then refuses the week with
//        DAY_FLAGGED until the flag clears.
//
// DELETE /api/service/day-fix-flag  { accountKey, iso }  -> clears
//        the flag ("No fix needed"). Same shape as the day-form
//        save's clear, but without a write to actuals.
//
// This route is a thin gate + wire to flagDayForFix / clearDayFix in
// @/lib/sc/submit/dayFixFlag; the write + lock logic lives there and
// is covered by unit tests that run each gate case.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { canWriteForAccount } from "@/lib/sc/access/canWriteForAccount";
import { flagDayForFix, clearDayFix } from "@/lib/sc/submit/dayFixFlag";
import type { ViewerLite } from "@/lib/sc/calendar/types";

export const dynamic = "force-dynamic";

interface Body {
  accountKey?: unknown;
  iso?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  return handle(req, "flag");
}

export async function DELETE(req: Request): Promise<Response> {
  return handle(req, "clear");
}

async function handle(req: Request, mode: "flag" | "clear"): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const email = gate.email;

  let body: Body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }
  const accountKey = typeof body.accountKey === "string" ? body.accountKey : null;
  const iso        = typeof body.iso        === "string" ? body.iso        : null;
  if (!accountKey) return NextResponse.json({ ok: false, message: "accountKey required" }, { status: 400 });
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return NextResponse.json({ ok: false, message: "iso must be YYYY-MM-DD" }, { status: 400 });
  }

  const sb = serviceClient();
  const scopeErr = await authorizeAccount(sb, email, accountKey);
  if (scopeErr) return scopeErr;

  const out = mode === "flag"
    ? await flagDayForFix(sb, { accountKey, iso, email })
    : await clearDayFix(sb, { accountKey, iso, email });

  if (out.ok) return NextResponse.json(out);
  const status = out.code === "NO_DAY_RECORD" ? 404
               : out.code === "WRITE_FAILED"  ? 500
               : 403;
  return NextResponse.json(out, { status });
}

async function authorizeAccount(sb: SupabaseClient, email: string, accountKey: string): Promise<Response | null> {
  const { viewer } = await resolveViewer(sb, email, null, true);
  if (!viewer) return NextResponse.json({ ok: false, code: "NOT_AUTHORIZED", message: "Viewer not on the roster." }, { status: 403 });
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
  const check = canWriteForAccount(lite, accountKey);
  if (!check.ok) return NextResponse.json(check, { status: 403 });
  return null;
}
