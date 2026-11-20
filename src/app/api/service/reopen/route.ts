// POST /api/service/reopen  { accountKey, weekStart, reason }
//
// Gate order (train 5, Kevin ruling 2026-11-20):
//   1. requireOwnerApi()                       -> 401/404 verbatim
//   2. authorize viewer + account              -> 403 NOT_AUTHORIZED
//   3. canReopenForAccount                     -> 403 NOT_ALLOWED
//   4. validate reason (non-empty, <=280)      -> 400 REASON_MISSING | REASON_TOO_LONG
//   5. load the live row; if role='rd' also run the period-closed
//      rpc against the period that holds the row's weekStart
//      -> 403 PERIOD_CLOSED (words name the override group by first
//      name read from `people`, never a string in code)
//   6. reopenWeek() handles NOT_LIVE / NOT_V2 / CANNOT_REOPEN_STATUS /
//      OUTBOUND_OFF_HAS_INVOICE / WEEK_HAS_LIVE_INVOICE /
//      QBO_CHECK_FAILED / LEDGER_SUPERSEDE_FAILED / REOPEN_WRITE_FAILED
//
// Notes:
//   - The `role` the scope helper returns is server-only. It is used
//     for step 5's period-closed branch and never shipped to the
//     client. The page sees `canReopen: boolean` and nothing else.
//   - Fiscal year + period number for sc_is_period_closed_fy come
//     from fiscal_periods. One read per in-scope reopen.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { visibleSites } from "@/lib/sc/calendar/accessList";
import type { AccountLite, ViewerLite } from "@/lib/sc/calendar/types";
import { canReopenForAccount } from "@/lib/sc/submit/canReopenScope";
import { listOverrideFirstNames } from "@/lib/sc/submit/overrideNames";
import { reopenWeek } from "@/lib/sc/submit/reopen";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  accountKey?: unknown;
  weekStart?: unknown;
  reason?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;
  const email = gate.email;

  let body: Body;
  try { body = await req.json(); }
  catch { return json({ ok: false, code: "SERVER_ERROR", message: "Invalid JSON" }, 400); }

  const accountKey = typeof body.accountKey === "string" ? body.accountKey : null;
  const weekStart  = typeof body.weekStart  === "string" ? body.weekStart  : null;
  const reasonRaw  = typeof body.reason     === "string" ? body.reason     : "";
  if (!accountKey) return json({ ok: false, code: "SERVER_ERROR", message: "accountKey required" }, 400);
  if (!weekStart || !ISO.test(weekStart)) {
    return json({ ok: false, code: "SERVER_ERROR", message: "weekStart must be YYYY-MM-DD" }, 400);
  }

  const sb = serviceClient();

  // ── viewer + scope ────────────────────────────────────────────
  const auth = await authorize(sb, email, accountKey);
  if (auth instanceof Response) return auth;
  const { viewer, account } = auth;
  void viewer;

  const scope = await canReopenForAccount(sb, email);
  if (!scope.ok) {
    return json(
      {
        ok: false,
        code: "NOT_ALLOWED",
        message: "Reopening a week is for the office and the regional directors.",
      },
      403,
    );
  }

  // ── reason ────────────────────────────────────────────────────
  const reason = reasonRaw.trim();
  if (!reason) return json({ ok: false, code: "REASON_MISSING", message: "A reason is required." }, 400);
  if (reason.length > 280) {
    return json({ ok: false, code: "REASON_TOO_LONG", message: "A reason is at most 280 characters." }, 400);
  }

  // ── rd + closed period = refuse ───────────────────────────────
  // Small 9 (2026-11-20): when the period cannot be checked, do NOT
  // say it is closed. Separate code (PERIOD_CHECK_FAILED) and words
  // so the person knows the system did not answer the question.
  if (scope.role === "rd") {
    const closed = await isPeriodClosedForWeek(sb, accountKey, weekStart);
    if (closed.unknown) {
      // Log the detail server-side; do not ship it to the browser
      // (small 8).
      console.error(`[reopen] period check failed for ${accountKey} ${weekStart}: ${closed.detail ?? "unknown"}`);
      return json(
        {
          ok: false,
          code: "PERIOD_CHECK_FAILED",
          message: "The period could not be checked, so the week was not reopened. Try again in a few minutes.",
        },
        503,
      );
    }
    if (closed.closed) {
      const names = await listOverrideFirstNames(sb);
      return json(
        {
          ok: false,
          code: "PERIOD_CLOSED",
          message: `This period is closed. ${names} can reopen it.`,
        },
        403,
      );
    }
  }

  // ── resolve a display name for the system note ────────────────
  const displayName = await resolveDisplayName(sb, email);
  void account;

  // ── the work ──────────────────────────────────────────────────
  const result = await reopenWeek(sb, {
    accountKey,
    weekStart,
    reason,
    email,
    authorDisplayName: displayName,
  });

  if (!result.ok) {
    // Small 8 (2026-11-20): do not ship `detail` to the browser —
    // it carries database error text and other server-only strings.
    // Log it on the server; return only { ok, code, message } +
    // the scrubbed public fields.
    if (result.detail) {
      console.error(`[reopen] ${result.code} ${accountKey} ${weekStart}: ${JSON.stringify(result.detail)}`);
    }
    const status =
      result.code === "NOT_LIVE" ? 404 :
      result.code === "CANNOT_REOPEN_STATUS" ? 403 :
      result.code === "NOT_V2" ? 403 :
      result.code === "PUSH_NOT_SETTLED" ? 409 :
      result.code === "OUTBOUND_OFF_HAS_INVOICE" ? 403 :
      result.code === "WEEK_HAS_LIVE_INVOICE" ? 403 :
      result.code === "QBO_CHECK_FAILED" ? 502 :
      result.code === "LEDGER_SUPERSEDE_FAILED" ? 500 :
      500;
    // WEEK_HAS_LIVE_INVOICE carries an `invoices: string[]` detail
    // (just the doc numbers, no server-side error text) that the
    // page shows. Expose that one field explicitly.
    const publicInvoices =
      result.code === "WEEK_HAS_LIVE_INVOICE" && result.detail && Array.isArray((result.detail as { invoices?: unknown }).invoices)
        ? ((result.detail as { invoices: unknown[] }).invoices)
        : undefined;
    const body: Record<string, unknown> = {
      ok: false,
      code: result.code,
      message: result.message,
    };
    if (publicInvoices) body.invoices = publicInvoices;
    return json(body, status);
  }

  // ── holding period for the post-success URL ───────────────────
  const holding = await periodHoldingWeek(sb, accountKey, result.revertedRow.week_start);
  return json(
    {
      ok: true,
      revertedRow: result.revertedRow,
      unitSpanStart: result.unitSpanStart,
      unitSpanEnd: result.unitSpanEnd,
      unitSpanDates: result.unitSpanDates,
      isBiweekly: result.isBiweekly,
      // The page uses this to navigate back to the calendar showing
      // the period that held the week. Null when the week sits
      // outside fiscal 2026 or the read fell through.
      holdingPeriod: holding,
      clearWarning: result.clearWarning,
      noteWarning: result.noteWarning,
    },
    200,
  );
}

// ── helpers ───────────────────────────────────────────────────────

async function authorize(
  sb: SupabaseClient,
  email: string,
  accountKey: string,
): Promise<Response | { viewer: ViewerLite; account: AccountLite }> {
  const { viewer } = await resolveViewer(sb, email, null, true);
  if (!viewer) return json({ ok: false, code: "NOT_AUTHORIZED", message: "You do not have access to this site." }, 403);
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
  const accQ = await sb
    .from("accounts")
    .select("team_key, name, region, level, timezone, active")
    .eq("active", true);
  if (accQ.error) {
    return json({ ok: false, code: "SERVER_ERROR", message: `accounts: ${accQ.error.message}` }, 500);
  }
  const accs = (accQ.data ?? []) as AccountLite[];
  const account = accs.find((a) => a.team_key === accountKey);
  if (!account) {
    return json({ ok: false, code: "NOT_AUTHORIZED", message: "You do not have access to this site." }, 403);
  }
  const inScope = visibleSites(lite, accs);
  if (!inScope.some((s) => s.accountKey === accountKey)) {
    return json({ ok: false, code: "NOT_AUTHORIZED", message: "You do not have access to this site." }, 403);
  }
  return { viewer: lite, account };
}

async function resolveDisplayName(sb: SupabaseClient, email: string): Promise<string | null> {
  const e = email.toLowerCase().trim();
  if (!e) return null;
  try {
    const { data, error } = await sb
      .from("people")
      .select("display_name, status")
      .eq("work_email", e)
      .limit(5);
    if (error) return null;
    const rows = (data ?? []) as Array<{ display_name: string | null; status: string | null }>;
    const active = rows.find((r) => r.status === "ACTIVE") ?? rows[0];
    return active?.display_name ?? null;
  } catch { return null; }
}

async function isPeriodClosedForWeek(
  sb: SupabaseClient,
  accountKey: string,
  weekStart: string,
): Promise<{ closed: boolean; unknown: boolean; detail?: string }> {
  // Find the fiscal period whose [start, end] contains weekStart.
  const { data: periodsRaw, error } = await sb
    .from("fiscal_periods")
    .select("fiscal_year, period_no, start_date, end_date")
    .lte("start_date", weekStart)
    .gte("end_date", weekStart)
    .limit(2);
  if (error) return { closed: false, unknown: true, detail: `fiscal_periods: ${error.message}` };
  const row = (periodsRaw ?? [])[0] as {
    fiscal_year: number; period_no: number; start_date: string; end_date: string;
  } | undefined;
  if (!row) return { closed: false, unknown: true, detail: "no fiscal period holds the week" };
  const r = await sb.rpc("sc_is_period_closed_fy", {
    p_account_key: accountKey,
    p_fiscal_year: row.fiscal_year,
    p_period_no: row.period_no,
  });
  if (r.error) return { closed: false, unknown: true, detail: `sc_is_period_closed_fy: ${r.error.message}` };
  return { closed: !!r.data, unknown: false };
}

async function periodHoldingWeek(
  sb: SupabaseClient,
  accountKey: string,
  weekStart: string,
): Promise<{ fiscal_year: number; period_no: number } | null> {
  void accountKey;
  const { data, error } = await sb
    .from("fiscal_periods")
    .select("fiscal_year, period_no")
    .lte("start_date", weekStart)
    .gte("end_date", weekStart)
    .limit(2);
  if (error) return null;
  const row = (data ?? [])[0] as { fiscal_year: number; period_no: number } | undefined;
  return row ?? null;
}

function json(body: unknown, status: number): Response {
  return NextResponse.json(body, { status });
}
