// Submit-week route.
//
// POST /api/service/submit-week
//   body: { accountKey: string; weekStart: string (Monday the review
//           page was opened with - for a biweekly pair, the CLOSING
//           week's Monday) }
//   returns a FinishPayload on success; the client plays the finish.
//
// Gate order:
//   1. requireOwnerApi()             -> 401/404 verbatim
//   2. canWriteForAccount            -> 403 NOT_AUTHORIZED
//   3. Outbound-OFF billed-site gate -> 403 OUTBOUND_OFF (round 2
//      billing safety: with the V2 gate off, a submit on a billed
//      account would lock the finalize row that v1 shares. v1 would
//      not know, and our push would never fire. Refuse here, before
//      submitWeek writes.)
//   4. submitWeek (runs every check, then LOCKS + RECORDS the row)
//      -> 403 BLOCKED on an empty-list refusal, 200 on a successful
//         write
//   5. Return the 200 to the site. Rule 9: the finish plays as soon
//      as the lock is on record.
//   6. AFTER the response commits, fire the push for billed sites.
//      The site sees nothing from this; a failed push reaches Kevin
//      + Sebastian through the engine's notice path (or the
//      throw-path give-up notice inside push.ts). Non-billed sites
//      and gate=off have no push to fire.
//
// Test-mode safety: resolveEffectiveQboMode (via scWeekFinalize's
// line 652) reads SC_V2_OUTBOUND first. Ship: env unset -> off ->
// outbound seam inert. Four billed accounts unreachable from V2.

import { NextResponse } from "next/server";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { visibleSites, siteInfoFrom } from "@/lib/sc/calendar/accessList";
import { canWriteForAccount } from "@/lib/sc/access/canWriteForAccount";
import { submitWeek } from "@/lib/sc/submit/submit";
import { attemptPushForRow } from "@/lib/sc/submit/push";
import { loadReviewTotals } from "@/lib/sc/submit/reviewLoader";
import { mondayOfWeek } from "@/lib/sc/scWeekFinalize";
import { isSubmitAllowed } from "@/lib/sc/submit/billedOutboundGate";
import type { AccountLite, SiteInfo, ViewerLite } from "@/lib/sc/calendar/types";
import type { SubmitBlock } from "@/lib/sc/types";

export const dynamic = "force-dynamic";

interface Body {
  accountKey?: unknown;
  weekStart?: unknown;
}

interface FinishPayload {
  accountKey: string;
  weekStart: string;
  unitSpanDays: number;
  submittedAt: string;
  isBilled: boolean;
  isPushPending: boolean;
  totalMeals: number;
  totalCents: number;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const email = gate.email;

  let body: Body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "Invalid JSON" }, { status: 400 });
  }

  const accountKey = typeof body.accountKey === "string" ? body.accountKey : null;
  const weekStart  = typeof body.weekStart  === "string" ? body.weekStart  : null;
  if (!accountKey) return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "accountKey required" }, { status: 400 });
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "weekStart must be YYYY-MM-DD" }, { status: 400 });
  }
  if (mondayOfWeek(weekStart) !== weekStart) {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: "weekStart must be a Monday" }, { status: 400 });
  }

  const sb = serviceClient();

  // Resolve the viewer + site once; the scope rule and the billed
  // flag both need them.
  const auth = await authorizeAndLoadSite(sb, email, accountKey);
  if (auth instanceof Response) return auth;
  const { viewer, site } = auth;

  // Outbound-OFF billed-site gate. A gate=test V2 can submit a billed
  // site - test mode posts an invoice to the test customer inside the
  // real QuickBooks company (not a QBO Sandbox; the engine routes to
  // ZZ TEST via resolveEffectiveQboMode + the adapter's allowlist).
  // A gate=off V2 can submit a not-billed site (no push to fire) but
  // must not touch a billed one. Predicate is in a shared file so
  // both the route and the page can agree + a unit test can pin the
  // decision without standing up the route.
  const allow = isSubmitAllowed(site.isBilled);
  if (!allow.allowed) {
    return NextResponse.json({ ok: false, code: allow.code, message: allow.message }, { status: 403 });
  }

  // Checks + lock + record. One call, one source of truth.
  const result = await submitWeek({ accountKey, weekStart, email }, sb);
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: "BLOCKED", blocks: result.blocks satisfies SubmitBlock[] }, { status: 403 });
  }

  const row = result.row;

  // Finish payload uses the same reader the week check used: one
  // source of truth for meals + before-tax cents, across the correct
  // submit unit (7 or 14 days from unitStart, not from row.week_start).
  const totals = await loadReviewTotals(sb, viewer, site, weekStart, email);
  const isPushPending = row.push_done_at === null && row.push_next_try_at !== null;
  const finish: FinishPayload = {
    accountKey: row.account_key,
    weekStart: row.week_start,
    unitSpanDays: totals.unitSpanDays,
    submittedAt: row.finalized_at,
    isBilled: site.isBilled,
    isPushPending,
    totalMeals: totals.totalMeals,
    totalCents: totals.totalCents,
  };

  if (isPushPending) {
    after(async () => {
      try {
        await attemptPushForRow(row.id);
      } catch (err) {
        console.error(`[submit-week] attemptPushForRow after() threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  return NextResponse.json({ ok: true as const, finish });
}

async function authorizeAndLoadSite(
  sb: SupabaseClient,
  email: string,
  accountKey: string,
): Promise<Response | { viewer: ViewerLite; site: SiteInfo }> {
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

  const accQ = await sb.from("accounts")
    .select("team_key, name, region, level, timezone, active")
    .eq("active", true);
  if (accQ.error) {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: `accounts: ${accQ.error.message}` }, { status: 500 });
  }
  const accs = (accQ.data ?? []) as AccountLite[];
  const inScope = visibleSites(lite, accs);
  const accountRow = accs.find((a) => a.team_key === accountKey);
  if (!accountRow) return NextResponse.json({ ok: false, code: "NOT_AUTHORIZED", message: "Unknown account." }, { status: 403 });
  if (!inScope.some((s) => s.accountKey === accountKey)) {
    return NextResponse.json({ ok: false, code: "NOT_AUTHORIZED", message: "Out of scope for this viewer." }, { status: 403 });
  }

  const check = canWriteForAccount(lite, accountKey);
  if (!check.ok) return NextResponse.json(check, { status: 403 });

  const amQ = await sb.from("sc_qbo_account_map")
    .select("cadence, active")
    .eq("account_key", accountKey)
    .maybeSingle();
  if (amQ.error) {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", message: `sc_qbo_account_map: ${amQ.error.message}` }, { status: 500 });
  }
  const site = siteInfoFrom(accountRow, (amQ.data as { cadence: "weekly" | "biweekly" | null; active: boolean | null } | null) ?? null);
  return { viewer: lite, site };
}
