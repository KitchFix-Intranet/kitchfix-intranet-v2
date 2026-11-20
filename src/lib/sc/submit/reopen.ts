// Train 5 (2026-11-20): reopen a submitted week.
//
// One function, 11 steps in the brief's order (corrected per
// Kevin ruling 2026-11-20: load the row first, then V2, then
// status). The route is a thin shell; every refusal and every
// write is here.
//
// Nothing in this file touches a wire directly. QuickBooks goes
// through qboCheckInvoice -> networkFetch, so SC_V2_OUTBOUND='off'
// throws before the wire. The route maps that case to the
// OUTBOUND_OFF_HAS_INVOICE refusal BEFORE calling into here when a
// live ledger row exists.
//
// Writes, in order:
//   1. sc_export_ledger UPDATE status='superseded' + superseded_by,
//      superseded_at, superseded_by_finalize_id = row.id (the
//      submit record whose reopen replaces the invoice is the one
//      we just loaded; nothing writes this later, by design — the
//      column comment names this row as the link). Fix 4: the
//      UPDATE is filtered by `.in("id", liveRowIds)` so a new live
//      row that appears between the read and the write is not
//      swept up. Row count must equal the number of live ledger
//      rows we asked QBO about; mismatch -> LEDGER_SUPERSEDE_FAILED
//      BEFORE step 2.
//   2. sc_week_finalize UPDATE status='reverted' + reverted_by/at/reason
//      on the live row's id.
//   3. clearReviewStateForDays over the unit's full span (14 for
//      biweekly closing, 7 for weekly). Non-fatal.
//   4. sc_day_note_entries insert ONE system note on the unit's
//      first day. Non-fatal.
//
// Ledger-first-then-record discipline: on a step-2 failure after
// step-1 succeeded, the ledger rows are `superseded` and the
// finalize row is still live. A second run of reopen finds no live
// ledger rows (step-1's WHERE matches zero), so step 1 is a no-op
// (row count 0 = count asked 0), and step 2 completes the reopen.
// A test proves it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveFinalizeReviewSpan } from "@/lib/sc/scWeekFinalize";
import { clearReviewStateForDays } from "@/lib/sc/scReviewState";
import { readQboInvoiceCheck, type LedgerRef } from "./qboCheckInvoice";
import { outboundMode } from "@/lib/sc/outboundGate";

export type ReopenResult =
  | {
      ok: true;
      revertedRow: {
        id: string;
        account_key: string;
        week_start: string;
        reverted_at: string;
        revert_reason: string;
      };
      unitSpanDates: string[];
      unitSpanStart: string;
      unitSpanEnd: string;
      isBiweekly: boolean;
      clearWarning: { error: string } | null;
      noteWarning: { error: string } | null;
    }
  | {
      ok: false;
      code:
        | "NOT_LIVE"
        | "NOT_V2"
        | "CANNOT_REOPEN_STATUS"
        | "PUSH_NOT_SETTLED"
        | "OUTBOUND_OFF_HAS_INVOICE"
        | "WEEK_HAS_LIVE_INVOICE"
        | "QBO_CHECK_FAILED"
        | "LEDGER_SUPERSEDE_FAILED"
        | "REOPEN_WRITE_FAILED";
      message: string;
      detail?: Record<string, unknown>;
    };

export interface ReopenArgs {
  accountKey: string;
  weekStart: string;
  reason: string;
  email: string;
  authorDisplayName: string | null; // for the system note's name
}

// Test seams. Production calls reopenWeek without this argument;
// the QBO check reads env vars and uses networkFetch.
export interface ReopenDeps {
  qboFetch?: (url: string, apiKey: string) => Promise<{ ok: boolean; status: number; body: string }>;
  qboEnv?: { proxyBase: string; realmId: string; apiKey: string };
}

// Refusal messages, per Kevin's table 2026-11-20.
const MSG = {
  NOT_LIVE: "This week is not submitted, so there is nothing to reopen.",
  NOT_V2: "This week was submitted in the old calendar. Reopen it there.",
  CANNOT_REOPEN_STATUS: "This week cannot be reopened from here. Tell the office.",
  // Fix 7 (2026-11-20): a push is in flight or waiting on a retry.
  // 409 at the route; the person tries again once the push has
  // settled.
  PUSH_NOT_SETTLED:
    "This week is still on its way to accounting. Try again in a few minutes.",
  OUTBOUND_OFF_HAS_INVOICE:
    "This week has an invoice, and billing from this calendar is switched off right now. It cannot be reopened here yet.",
  QBO_CHECK_FAILED:
    "QuickBooks could not be reached, so the week was not reopened. Nothing changed. Try again in a few minutes.",
  LEDGER_SUPERSEDE_FAILED:
    "The invoice could not be marked as replaced, so the week was not reopened. Tell the office.",
  REOPEN_WRITE_FAILED: "The week was not reopened. Tell the office before trying again.",
};

export async function reopenWeek(
  sb: SupabaseClient,
  args: ReopenArgs,
  deps?: ReopenDeps,
): Promise<ReopenResult> {
  const { accountKey, weekStart, reason, email, authorDisplayName } = args;

  // ── load the live row ─────────────────────────────────────────
  const { data: rowRaw, error: loadErr } = await sb
    .from("sc_week_finalize")
    .select("id, account_key, week_start, status, submitted_via, finalized_at, push_next_try_at, push_done_at, push_gave_up_at")
    .eq("account_key", accountKey)
    .eq("week_start", weekStart)
    .neq("status", "reverted")
    .maybeSingle();
  if (loadErr) {
    return refuse("REOPEN_WRITE_FAILED", { detail: { loadErr: loadErr.message } });
  }
  const row = rowRaw as {
    id: string;
    account_key: string;
    week_start: string;
    status: string;
    submitted_via: string | null;
    finalized_at: string;
    push_next_try_at: string | null;
    push_done_at: string | null;
    push_gave_up_at: string | null;
  } | null;
  if (!row) return refuse("NOT_LIVE");
  if (row.submitted_via !== "v2") return refuse("NOT_V2");
  if (row.status !== "finalized" && row.status !== "push_failed") {
    return refuse("CANNOT_REOPEN_STATUS", { detail: { status: row.status } });
  }

  // Fix 7 (2026-11-20): a push is in flight OR waiting on a retry.
  // `submit.ts` sets `push_next_try_at = now()` on a billed site at
  // submit time and clears it on success (push_done_at) or give-up
  // (push_gave_up_at). So the three-way predicate below is "billed
  // V2 week whose push has not settled yet" — in flight or scheduled
  // for the next attempt. Refuse with PUSH_NOT_SETTLED; a 409 at the
  // route. The retry-pending test in train 5 round 1 covers the
  // existing behaviour (reopen wins the race); this guard adds the
  // explicit refusal so an operator never flips the record while
  // a push is still live.
  const pushUnsettled =
    row.push_next_try_at !== null &&
    row.push_done_at === null &&
    row.push_gave_up_at === null;
  if (pushUnsettled) return refuse("PUSH_NOT_SETTLED");

  // ── resolve the unit (weekly or biweekly pair) ────────────────
  const span = await resolveFinalizeReviewSpan(accountKey, weekStart, sb);
  const spanStart = span.spanStart;
  const spanEnd = span.spanEnd;
  const unitDates = span.dates;
  const isBiweekly = !!span.isBiweekly && unitDates.length === 14;

  // ── pre-flight the ledger ─────────────────────────────────────
  const { data: liveRowsRaw, error: liveErr } = await sb
    .from("sc_export_ledger")
    .select("id, qbo_doc_number, qbo_invoice_id")
    .eq("account_key", accountKey)
    .eq("week_start", spanStart)
    .eq("status", "created")
    .eq("is_test", false);
  if (liveErr) {
    return refuse("REOPEN_WRITE_FAILED", { detail: { liveErr: liveErr.message } });
  }
  const liveRows = (liveRowsRaw ?? []) as Array<{
    id: string;
    qbo_doc_number: string | null;
    qbo_invoice_id: string | null;
  }>;

  // Outbound-off refusal: a live ledger row + outbound off = no reopen.
  if (liveRows.length > 0 && outboundMode() === "off") {
    return refuse("OUTBOUND_OFF_HAS_INVOICE");
  }

  // ── ask QBO about every live row ──────────────────────────────
  if (liveRows.length > 0) {
    let anyStillThere: typeof liveRows[number] | null = null;
    let anyCannotAsk = false;
    const asked: LedgerRef[] = [];
    for (const r of liveRows) {
      const check = await readQboInvoiceCheck(
        { qbo_doc_number: r.qbo_doc_number, qbo_invoice_id: r.qbo_invoice_id },
        deps?.qboFetch || deps?.qboEnv
          ? {
              fetchImpl: deps?.qboFetch,
              proxyBase: deps?.qboEnv?.proxyBase,
              realmId: deps?.qboEnv?.realmId,
              apiKey: deps?.qboEnv?.apiKey,
            }
          : undefined,
      );
      asked.push({ qbo_doc_number: r.qbo_doc_number, qbo_invoice_id: r.qbo_invoice_id });
      if (check.kind === "still_there") { anyStillThere = r; break; }
      if (check.kind === "cannot_ask") { anyCannotAsk = true; }
    }
    if (anyStillThere) {
      // Voided or live, the message is the same.
      const label = anyStillThere.qbo_doc_number ?? `(id ${anyStillThere.qbo_invoice_id ?? "?"})`;
      return {
        ok: false,
        code: "WEEK_HAS_LIVE_INVOICE",
        message: `QuickBooks still holds invoice ${label}. A voided invoice still counts. Accounting deletes it in QuickBooks first.`,
        detail: { invoices: liveRows.map((r) => r.qbo_doc_number ?? r.qbo_invoice_id).filter(Boolean) },
      };
    }
    if (anyCannotAsk) {
      return refuse("QBO_CHECK_FAILED");
    }

    // All rows gone. Supersede in one statement.
    //
    // Fix 3 (2026-11-20): `superseded_by_finalize_id = row.id`. The
    //   column names the submit record whose reopen replaces the
    //   invoice; that record is the one we just loaded. Nothing
    //   writes this value later.
    // Fix 4 (2026-11-20): `.in("id", liveRowIds)` so a new live row
    //   that appeared between the pre-flight read and this UPDATE is
    //   not swept into `superseded` without ever being asked.
    const nowIso = new Date().toISOString();
    const liveRowIds = liveRows.map((r) => r.id);
    const { data: updatedRows, error: supErr } = await sb
      .from("sc_export_ledger")
      .update({
        status: "superseded",
        superseded_by: email,
        superseded_at: nowIso,
        superseded_by_finalize_id: row.id,
      })
      .in("id", liveRowIds)
      .eq("status", "created")
      .eq("is_test", false)
      .select("id");
    if (supErr) {
      return refuse("LEDGER_SUPERSEDE_FAILED", { detail: { err: supErr.message } });
    }
    if ((updatedRows ?? []).length !== liveRows.length) {
      return refuse("LEDGER_SUPERSEDE_FAILED", {
        detail: {
          asked: asked.length,
          updated: (updatedRows ?? []).length,
        },
      });
    }
  }

  // ── flip the week's record ────────────────────────────────────
  const revertedAt = new Date().toISOString();
  const trimmedReason = reason.trim();
  const { data: updatedRaw, error: updErr } = await sb
    .from("sc_week_finalize")
    .update({
      status: "reverted",
      reverted_by: email,
      reverted_at: revertedAt,
      revert_reason: trimmedReason,
    })
    .eq("id", row.id)
    .select("id, account_key, week_start, reverted_at, revert_reason")
    .maybeSingle();
  if (updErr || !updatedRaw) {
    return refuse("REOPEN_WRITE_FAILED", {
      detail: {
        err: updErr?.message ?? "no row returned",
        // If this failed AFTER the supersede landed, the next
        // reopen attempt is the recovery path: no live ledger rows
        // remain, so supersede is a no-op (count 0 === asked 0),
        // and this update retries.
        supersededRows: liveRows.length,
      },
    });
  }
  const updated = updatedRaw as {
    id: string; account_key: string; week_start: string;
    reverted_at: string; revert_reason: string;
  };

  // ── clear the day marks, non-fatal ───────────────────────────
  let clearWarning: { error: string } | null = null;
  try {
    const out = await clearReviewStateForDays(accountKey, unitDates, sb);
    if (!out.success) {
      clearWarning = { error: out.error ?? "clear failed" };
      console.error(`[sc/reopen] clear-review failed for ${accountKey} ${spanStart}: ${out.error}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clearWarning = { error: msg };
    console.error(`[sc/reopen] clear-review threw for ${accountKey} ${spanStart}: ${msg}`);
  }

  // ── system note on the first day, non-fatal ──────────────────
  let noteWarning: { error: string } | null = null;
  try {
    const name = authorDisplayName && authorDisplayName.trim() ? authorDisplayName.trim() : "Someone";
    const noteText = isBiweekly
      ? `Two weeks reopened by ${name}: ${trimmedReason}`
      : `Week reopened by ${name}: ${trimmedReason}`;
    const { error: noteErr } = await sb.from("sc_day_note_entries").insert({
      account_key: accountKey,
      service_date: spanStart,
      note: noteText,
      author: email,
      source: null,
    });
    if (noteErr) {
      noteWarning = { error: noteErr.message };
      console.error(`[sc/reopen] note insert failed for ${accountKey} ${spanStart}: ${noteErr.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    noteWarning = { error: msg };
    console.error(`[sc/reopen] note insert threw for ${accountKey} ${spanStart}: ${msg}`);
  }

  return {
    ok: true,
    revertedRow: {
      id: updated.id,
      account_key: updated.account_key,
      week_start: updated.week_start,
      reverted_at: updated.reverted_at,
      revert_reason: updated.revert_reason,
    },
    unitSpanDates: unitDates,
    unitSpanStart: spanStart,
    unitSpanEnd: spanEnd,
    isBiweekly,
    clearWarning,
    noteWarning,
  };
}

function refuse<C extends Extract<ReopenResult, { ok: false }>["code"]>(
  code: C,
  extra: { detail?: Record<string, unknown> } = {},
): Extract<ReopenResult, { ok: false }> {
  return {
    ok: false,
    code,
    message: MSG[code as keyof typeof MSG],
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}
