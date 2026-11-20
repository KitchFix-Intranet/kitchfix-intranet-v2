// Friday reminder cron.
//
// Vercel calendar entry (vercel.json): hits this route at 20:00 and
// 21:00 UTC on Fridays. The handler asks the scheduler whether it
// is 15:00 America/Chicago right now; the off-hour firing does
// nothing.
//
// Auth:
//   real run    : cron only. An owner session hitting this route
//                 without `?dry=1` is rejected.
//   `?dry=1`    : owner session required. Composes the full decision
//                 for every site and returns counts + reasons only.
//                 No addresses, no names, no subjects. Writes and
//                 sends nothing.
//
// One site failing cannot stop the rest: per-site try/catch records
// `error` and the loop continues.

import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { sendReminder, dryRunReminder, type ReminderPublicResult } from "@/lib/sc/submit/reminderSend";
import { isFridayCentralHour, reminderWeekStartFriday } from "@/lib/sc/submit/reminderScheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }

async function handle(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const isDry = url.searchParams.get("dry") === "1";

  if (isDry) {
    const gate = await requireOwnerApi();
    if (gate instanceof Response) return gate;
  } else {
    // Real run: cron-only. An owner session is NOT accepted.
    if (!isCronAuthorized(req)) {
      return NextResponse.json(
        { ok: false, code: "CRON_ONLY", message: "Real reminder runs are cron-only." },
        { status: 401 },
      );
    }
  }

  const now = new Date();
  if (!isDry && !isFridayCentralHour(now)) {
    return NextResponse.json({ ok: true, count: 0, results: [] });
  }

  const sb = serviceClient();
  const sites = await loadCalendarSites(sb);

  const results: ReminderPublicResult[] = [];
  for (const site of sites) {
    try {
      const weekStart = reminderWeekStartFriday(now, site.timezone);
      if (!weekStart) {
        results.push(skipResult(site.accountKey, "wrong_hour"));
        continue;
      }
      const base = {
        sb,
        accountKey: site.accountKey,
        siteName: site.name,
        timezone: site.timezone,
        kind: "friday" as const,
        weekStart,
      };
      const r = isDry ? await dryRunReminder(base) : await sendReminder(base);
      results.push(r);
    } catch (e: unknown) {
      console.error(`[reminder-friday] ${site.accountKey} threw: ${e instanceof Error ? e.message : String(e)}`);
      results.push(skipResult(site.accountKey, "error"));
    }
  }

  return NextResponse.json({ ok: true, dry: isDry, count: results.length, results });
}

function skipResult(accountKey: string, reason: "wrong_hour" | "error"): ReminderPublicResult {
  return {
    accountKey,
    weekStart: "",
    unitStart: "",
    unitEnd: "",
    decision: "skip",
    reason,
    leaders: 0,
    directors: 0,
    mode: "off",
    outcome: "skipped",
  };
}

async function loadCalendarSites(sb: ReturnType<typeof serviceClient>) {
  // Active calendar accounts: exclude MLB and CORP explicitly.
  const accQ = await sb
    .from("accounts")
    .select("team_key, name, region, level, timezone, active")
    .eq("active", true)
    .not("level", "in", "(MLB,CORP)")
    .order("team_key");
  if (accQ.error) throw new Error(`accounts: ${accQ.error.message}`);
  const rows = (accQ.data ?? []) as Array<{
    team_key: string;
    name: string | null;
    region: string | null;
    level: string | null;
    timezone: string | null;
    active: boolean | null;
  }>;
  if (rows.length === 0) return [];
  const keys = rows.map((r) => r.team_key);
  const svcQ = await sb
    .from("sc_services")
    .select("account_key")
    .in("account_key", keys)
    .eq("active", true);
  if (svcQ.error) throw new Error(`sc_services: ${svcQ.error.message}`);
  const haveActiveService = new Set(((svcQ.data ?? []) as Array<{ account_key: string }>).map((r) => r.account_key));
  return rows
    .filter((r) => haveActiveService.has(r.team_key))
    .map((r) => ({
      accountKey: r.team_key,
      name: r.name ?? r.team_key,
      timezone: r.timezone ?? "America/Chicago",
    }));
}
