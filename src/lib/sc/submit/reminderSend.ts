// Train 6: reminder orchestration for a single site.
//
// Called from the two cron routes (Friday + Monday) once the route
// has decided it is the right local hour for this site. The caller
// hands us the Supabase service client + the site + the stage; we
// do everything from there:
//
//   1. Compute the unit via `resolveFinalizeReviewSpan` (the same
//      helper the submit, the board and the reopen use). `isBiweekly`,
//      `weekIndex`, `spanStart`, `spanEnd`, `dates` come from there.
//      Short-circuit a biweekly opening-week fire.
//   2. Short-circuit when the week is already submitted.
//   3. Short-circuit via `isAskedYet` (pre-FY27-cutover never-submitted
//      sites). Passed the site's Chicago-stable today.
//   4. Short-circuit when the unit has no service at all (no actual
//      and no projection above 0 across the whole span).
//   5. Short-circuit when (account_key, week_start, stage, is_test)
//      already has a row in `sc_v2_reminder_sent` (dedup).
//   6. Resolve recipients. Friday = site leaders only. Monday =
//      leaders + 0..N regional directors.
//   7. Zero recipients -> insert row with
//      email_result='skipped_no_recipients' and stop.
//   8. Insert row with email_result=null (claim), compose + send,
//      update row with 'sent' or 'failed'.
//
// Dry-run contract (Chat ruling 2026-11-20): pass `{ dryRun: true }`
// to receive counts + reason only. NO addresses, NO person names,
// NO subjects, NO html. The real run returns the same shape plus
// `outcome`; the route also carries no addresses in the returned
// response.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmailSA } from "@/lib/sc/outbound";
import { outboundMode } from "@/lib/sc/outboundGate";
import { KEVIN_EMAIL } from "@/lib/sc/billing/recipients";
import { _internals as qboInternals } from "@/lib/sc/billing/qboNotifications";
import { composeReminder, type ReminderKind, type ReminderComposed } from "./reminderRender";
import { reminderMode } from "./reminderMode";
import { loadSiteLeaders, loadRegionDirectors } from "./reminderRecipients";
import { appBaseUrl } from "./appBaseUrl";
import { accountKeyToSlug } from "@/lib/sc/calendar/slug";
import { resolveFinalizeReviewSpan } from "@/lib/sc/scWeekFinalize";
import { isAskedYet } from "@/lib/sc/calendar/isAskedYet";
import { localPartsInZone } from "./reminderScheduler";

const { EMAIL_SENDER, EMAIL_DISPLAY_NAME } = qboInternals;

export interface ReminderSendInput {
  sb: SupabaseClient;
  accountKey: string;
  siteName: string;
  timezone: string;
  kind: ReminderKind;
  weekStart: string;                // The Monday to anchor the span at.
  dryRun?: boolean;
}

export type ReminderReason =
  | "already_submitted"
  | "not_asked_yet"
  | "no_service"
  | "not_closing_week"
  | "already_reminded"
  | "no_recipients"
  | "wrong_hour"
  | "error";

export type ReminderDecision = "remind" | "skip";

export interface ReminderPublicResult {
  accountKey: string;
  weekStart: string;                // The submit-row Monday (pair's closing Monday for biweekly).
  unitStart: string;                // Opening Monday of the unit.
  unitEnd: string;                  // Closing Sunday of the unit.
  decision: ReminderDecision;
  reason: ReminderReason | null;    // Why skip; null when decision=remind.
  leaders: number;
  directors: number;
  mode: "off" | "test" | "live";
  outcome?: "mode_off" | "sent" | "failed" | "skipped";   // Real run only.
}

interface InternalEnvelope {
  public: ReminderPublicResult;
  recipients: { to: string[]; cc: string[] };
  composed: ReminderComposed | null;
  isTest: boolean;
  rowId: string | null;
  submitMonday: string;             // The sc_week_finalize key for this unit.
}

async function build(input: ReminderSendInput): Promise<InternalEnvelope> {
  const mode = reminderMode(outboundMode());
  const isTest = mode === "test";

  // 1. Unit from the authoritative helper.
  const span = await resolveFinalizeReviewSpan(input.accountKey, input.weekStart, input.sb);
  const isOpeningBiweekly = span.isBiweekly && (span.weekIndex === 1 || span.weekIndex === 3);
  // For a biweekly opening week there is no submit row anchored
  // here; the pair closes on the next Monday.
  const submitMonday = input.weekStart;

  const env: InternalEnvelope = {
    public: {
      accountKey: input.accountKey,
      weekStart: submitMonday,
      unitStart: span.spanStart,
      unitEnd: span.spanEnd,
      decision: "skip",
      reason: null,
      leaders: 0,
      directors: 0,
      mode,
    },
    recipients: { to: [], cc: [] },
    composed: null,
    isTest,
    rowId: null,
    submitMonday,
  };

  if (isOpeningBiweekly) {
    env.public.reason = "not_closing_week";
    return env;
  }

  // Tidy 2: a biweekly site with no readable "Week N" label must not
  // silently fall through as if it were weekly. Skip with
  // `reason="error"` so the gap surfaces in the dry-run.
  if (span.isBiweekly && span.weekIndex == null) {
    env.public.reason = "error";
    return env;
  }

  // 2. Already submitted?
  const submitted = await isAlreadySubmitted(input.sb, input.accountKey, submitMonday);
  if (submitted) {
    env.public.reason = "already_submitted";
    return env;
  }

  // 3. Asked-yet gate (shared with the calendar + the board).
  const today = siteToday(input.timezone);
  const anyFinalizeEver = await anyFinalizeRowEver(input.sb, input.accountKey);
  if (!isAskedYet({ today, unitEndIso: span.spanEnd, anyFinalizeRowEver: anyFinalizeEver })) {
    env.public.reason = "not_asked_yet";
    return env;
  }

  // 4. Any service at all in the unit?
  const hasAnyService = await unitHasAnyService(input.sb, input.accountKey, span.dates);
  if (!hasAnyService) {
    env.public.reason = "no_service";
    return env;
  }

  // 5. Resolve recipients. Friday = leaders only; Monday = leaders +
  //    regional directors.
  const leaders = await loadSiteLeaders(input.sb, input.accountKey);
  const region = input.kind === "monday" ? await loadAccountRegion(input.sb, input.accountKey) : null;
  const directors = input.kind === "monday"
    ? await loadRegionDirectors(input.sb, region)
    : [];
  env.public.leaders = leaders.length;
  env.public.directors = directors.length;

  const rdCountForTrailer = input.kind === "monday" ? directors.length : 0;
  const rdFirstName = rdCountForTrailer === 1 && directors[0].displayName
    ? String(directors[0].displayName).trim().split(/\s+/)[0] || null
    : null;

  const liveTo = Array.from(new Set(
    leaders.map((l) => l.email).concat(directors.map((d) => d.email)),
  )).filter(Boolean);
  const to = isTest ? [KEVIN_EMAIL] : liveTo;

  const isBilled = await siteIsBilled(input.sb, input.accountKey);

  const slug = accountKeyToSlug(input.accountKey);
  const q = new URLSearchParams({ site: slug, week: submitMonday });
  const scWeekLink = `${appBaseUrl()}/service/review?${q.toString()}`;

  env.recipients = { to, cc: [] };
  env.composed = composeReminder({
    kind: input.kind,
    siteName: input.siteName,
    leaderDisplayNames: leaders.map((l) => l.displayName),
    weekStartIso: span.spanStart,
    weekEndIso: span.spanEnd,
    isBiweekly: span.isBiweekly && (span.weekIndex === 2 || span.weekIndex === 4),
    isBilled,
    rdFirstName,
    rdCount: rdCountForTrailer,
    scWeekLink,
    isTest,
  });

  // No recipients in live mode (test mode routes to Kevin; that list
  // is never empty).
  if (to.length === 0) {
    env.public.reason = "no_recipients";
    return env;
  }

  // 6. Dedup pre-check (the unique index is the truth; this read is
  //    the fast path).
  const dup = await isAlreadyRemindedToday(
    input.sb,
    input.accountKey,
    submitMonday,
    input.kind === "friday" ? "v2.friday" : "v2.monday",
    isTest,
  );
  if (dup) {
    env.public.reason = "already_reminded";
    return env;
  }

  env.public.decision = "remind";
  env.public.reason = null;
  return env;
}

// Dry run: full decision shape, no addresses / no subject / no html.
export async function dryRunReminder(input: ReminderSendInput): Promise<ReminderPublicResult> {
  const env = await build({ ...input, dryRun: true });
  return env.public;
}

export async function sendReminder(input: ReminderSendInput): Promise<ReminderPublicResult> {
  const mode = reminderMode(outboundMode());
  if (mode === "off") {
    // No DB read, no write, no wire. The lane's off mode is inert.
    return {
      accountKey: input.accountKey,
      weekStart: input.weekStart,
      unitStart: input.weekStart,
      unitEnd: input.weekStart,
      decision: "skip",
      reason: null,
      leaders: 0,
      directors: 0,
      mode: "off",
      outcome: "mode_off",
    };
  }

  const env = await build(input);

  // Any skip reason: record nothing for most reasons. Only
  // "no_recipients" gets a recorded row so the gap is visible.
  if (env.public.decision === "skip") {
    if (env.public.reason === "no_recipients") {
      const row = await insertReminderRow(input.sb, {
        accountKey: input.accountKey,
        weekStart: env.submitMonday,
        stage: input.kind === "friday" ? "v2.friday" : "v2.monday",
        to: [],
        cc: [],
        isTest: env.isTest,
        result: "skipped_no_recipients",
      });
      env.rowId = row;
    }
    return { ...env.public, outcome: "skipped" };
  }

  // 7. Insert row (claim). The unique index means a racing second
  //    cron tick cannot double-send.
  let rowId: string | null = null;
  try {
    rowId = await insertReminderRow(input.sb, {
      accountKey: input.accountKey,
      weekStart: env.submitMonday,
      stage: input.kind === "friday" ? "v2.friday" : "v2.monday",
      to: env.recipients.to,
      cc: env.recipients.cc,
      isTest: env.isTest,
      result: null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key|unique/i.test(msg)) {
      return { ...env.public, decision: "skip", reason: "already_reminded", outcome: "skipped" };
    }
    throw e;
  }

  // 8. Send through the lane's single door. The engine's sender
  //    constant + display name are reused so there is one visible
  //    "From" across every lane message.
  const result = await sendEmailSA({
    sender: EMAIL_SENDER,
    displayName: EMAIL_DISPLAY_NAME,
    to: env.recipients.to,
    cc: env.recipients.cc.length > 0 ? env.recipients.cc : undefined,
    subject: env.composed!.subject,
    html: env.composed!.html,
  });

  await updateReminderRowResult(input.sb, rowId, result);

  return { ...env.public, outcome: result };
}

// ─── Site-today, submission state, service state, dedup ────────

function siteToday(timeZone: string): string {
  const p = localPartsInZone(new Date(), timeZone || "America/Chicago");
  if (!p) return new Date().toISOString().slice(0, 10);
  const m = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  return `${p.year}-${m}-${d}`;
}

export async function isAlreadySubmitted(
  sb: SupabaseClient,
  accountKey: string,
  weekStart: string,
): Promise<boolean> {
  const { count, error } = await sb
    .from("sc_week_finalize")
    .select("id", { count: "exact", head: true })
    .eq("account_key", accountKey)
    .eq("week_start", weekStart)
    .neq("status", "reverted");
  if (error) throw new Error(`isAlreadySubmitted: ${error.message}`);
  return (count ?? 0) > 0;
}

async function anyFinalizeRowEver(sb: SupabaseClient, accountKey: string): Promise<boolean> {
  const { count, error } = await sb
    .from("sc_week_finalize")
    .select("id", { count: "exact", head: true })
    .eq("account_key", accountKey)
    .neq("status", "reverted");
  if (error) throw new Error(`anyFinalizeRowEver: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function unitHasAnyService(
  sb: SupabaseClient,
  accountKey: string,
  dates: readonly string[],
): Promise<boolean> {
  if (dates.length === 0) return false;
  // "No service" = no actual entered AND no projection above 0 across
  // the unit. The Dec 21 + Dec 28 holiday weeks are this case.
  const { data, error } = await sb
    .from("sc_daily_revenue")
    .select("actual_count, projected_count")
    .eq("account_key", accountKey)
    .in("service_date", dates as string[]);
  if (error) throw new Error(`unitHasAnyService: ${error.message}`);
  for (const r of (data ?? []) as Array<{ actual_count: number | null; projected_count: number | null }>) {
    const a = Number(r.actual_count ?? 0);
    const p = Number(r.projected_count ?? 0);
    if (a > 0 || p > 0) return true;
  }
  return false;
}

export async function isAlreadyRemindedToday(
  sb: SupabaseClient,
  accountKey: string,
  weekStart: string,
  stage: "v2.friday" | "v2.monday",
  isTest: boolean,
): Promise<boolean> {
  const { count, error } = await sb
    .from("sc_v2_reminder_sent")
    .select("id", { count: "exact", head: true })
    .eq("account_key", accountKey)
    .eq("week_start", weekStart)
    .eq("stage", stage)
    .eq("is_test", isTest);
  if (error) throw new Error(`isAlreadyRemindedToday: ${error.message}`);
  return (count ?? 0) > 0;
}

async function loadAccountRegion(sb: SupabaseClient, accountKey: string): Promise<string | null> {
  const { data, error } = await sb
    .from("accounts")
    .select("region")
    .eq("team_key", accountKey)
    .maybeSingle();
  if (error) throw new Error(`loadAccountRegion: ${error.message}`);
  return (data as { region: string | null } | null)?.region ?? null;
}

async function siteIsBilled(sb: SupabaseClient, accountKey: string): Promise<boolean> {
  const { data, error } = await sb
    .from("sc_qbo_account_map")
    .select("active")
    .eq("account_key", accountKey)
    .maybeSingle();
  if (error) throw new Error(`siteIsBilled: ${error.message}`);
  const row = data as { active: boolean | null } | null;
  return !!row && row.active !== false;
}

async function insertReminderRow(
  sb: SupabaseClient,
  row: {
    accountKey: string;
    weekStart: string;
    stage: "v2.friday" | "v2.monday";
    to: string[];
    cc: string[];
    isTest: boolean;
    result: "sent" | "failed" | "skipped_no_recipients" | null;
  },
): Promise<string | null> {
  const { data, error } = await sb
    .from("sc_v2_reminder_sent")
    .insert({
      account_key: row.accountKey,
      week_start: row.weekStart,
      stage: row.stage,
      recipients_to: row.to,
      recipients_cc: row.cc,
      email_result: row.result,
      is_test: row.isTest,
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertReminderRow: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

async function updateReminderRowResult(
  sb: SupabaseClient,
  rowId: string | null,
  result: "sent" | "failed",
): Promise<void> {
  if (!rowId) return;
  const { error } = await sb
    .from("sc_v2_reminder_sent")
    .update({ email_result: result })
    .eq("id", rowId);
  if (error) throw new Error(`updateReminderRowResult: ${error.message}`);
}
