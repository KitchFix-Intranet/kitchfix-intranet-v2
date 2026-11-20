// Monday reminder cron.
//
// Vercel calendar entry (vercel.json): fires every hour between
// 13:00 and 17:00 UTC on Mondays. The window spans 9 AM local for
// every timezone we run (America/New_York, America/Chicago,
// America/Phoenix) across both DST and standard time. The handler
// loops the sites and asks the scheduler whether it is 9 AM local
// for each; off-hour sites get `wrong_hour` and move on.
//
// Owner `?dry=1` works the same as the Friday route.

import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { sendReminder, dryRunReminder, type ReminderPublicResult } from "@/lib/sc/submit/reminderSend";
import { isMondayNineAtTz, reminderWeekStartMonday } from "@/lib/sc/submit/reminderScheduler";

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
    if (!isCronAuthorized(req)) {
      return NextResponse.json(
        { ok: false, code: "CRON_ONLY", message: "Real reminder runs are cron-only." },
        { status: 401 },
      );
    }
  }

  const now = new Date();
  const sb = serviceClient();
  const sites = await loadCalendarSites(sb);

  const results: ReminderPublicResult[] = [];
  for (const site of sites) {
    try {
      const onTheHour = isDry || isMondayNineAtTz(now, site.timezone);
      if (!onTheHour) {
        results.push(skipResult(site.accountKey, "wrong_hour"));
        continue;
      }
      const weekStart = reminderWeekStartMonday(now, site.timezone);
      if (!weekStart) {
        results.push(skipResult(site.accountKey, "wrong_hour"));
        continue;
      }
      const base = {
        sb,
        accountKey: site.accountKey,
        siteName: site.name,
        timezone: site.timezone,
        kind: "monday" as const,
        weekStart,
      };
      const r = isDry ? await dryRunReminder(base) : await sendReminder(base);
      results.push(r);
    } catch (e: unknown) {
      console.error(`[reminder-monday] ${site.accountKey} threw: ${e instanceof Error ? e.message : String(e)}`);
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
