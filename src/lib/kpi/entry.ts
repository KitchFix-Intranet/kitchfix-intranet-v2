// src/lib/kpi/entry.ts
//
// The engine's one public door.
//
// Train 2b inputs (beyond train 2a):
//   fiscalYear  a loaded FiscalYear object. The entry does not guess
//               a year from today's date; the caller passes the one
//               the request is for. Two different years can be served
//               by the same running process at the same moment.
//   now         a full timestamp from the caller. The engine never
//               reads the clock; every leaf that needs "the current
//               moment" reads from this field. Same shape as `today`:
//               an input, never derived.
//
// The entry does what v1's GET handler does from line 111 to line
// 298 of route.js, in the same order, with the same outcomes
// (preview narrowing, no-account landing, CORP refusal, not-authorised,
// salary gate, parseRange, resolveOverview, preview_account /
// landing_account / export / range_snap / todayISO).

import { resolvePreviewAccess } from "./previewAccess";
import { canViewAccount, canSeeSalary, landingAccount } from "./roleGate";
import { isKnownAccount } from "./accountModels";
import { resolveOverview } from "./overview/resolver";
import { snapRange } from "./rangeSnap";
import { periodStartISO, periodEndISO } from "./labor/periods";
import type { FiscalYear } from "./shared/fiscalYear";

const V6_PSEUDO_KEYS = new Set(["ALL", "EAST", "WEST"]);

// v1 route.js `safeError` + its log line. Train 2b restores the log
// so a 5xx is never silent. Scope + error.message only; a payload,
// figure, name or address never appears here.
function safeError(scope: string, err: any) {
  try {
    const message = err?.message ?? String(err);
    const stack = err?.stack ?? "";
    // eslint-disable-next-line no-console
    console.error(`[kpi/overview] ${scope}: ${message}\n${stack}`);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[kpi/overview] ${scope}: (unprintable error)`);
  }
  return { error: "server_error", scope };
}

// parseRange mirrors v1 route.js:58-84. The caller supplies the four
// query-string pieces as plain strings; the entry does not read the
// URL itself.
function parseRange({ range = "", start = "", end = "" }: { range?: string; start?: string; end?: string }, today: string, fy: FiscalYear) {
  const rangeParam = range.trim();
  const startParam = start.trim();
  const endParam = end.trim();
  if (rangeParam === "fytd") return { snap: snapRange("", "", today, fy), rangeParamSeen: "fytd" };
  if (rangeParam.startsWith("period:")) {
    const n = Number(rangeParam.slice("period:".length));
    if (Number.isInteger(n) && n >= 1 && n <= 13) {
      return {
        snap: {
          start: periodStartISO(n, fy), end: periodEndISO(n, fy),
          kind: "period", period_no: n,
          start_period_no: n, end_period_no: n,
          snapped: false, snapped_from: null,
        },
      };
    }
  }
  return { snap: snapRange(startParam, endParam, today, fy) };
}

type EntryQuery = {
  account?: string;
  preview?: string;
  include_salary?: boolean | string;
  debug?: string;
  range?: string;
  start?: string;
  end?: string;
};

type EntryCaller = {
  role: string;
  scope: string | null;
  can_see_salary?: boolean;
} | null;

type EntryArgs = {
  supa: any;
  today: string;
  now: Date | string | number;
  fiscalYear: FiscalYear;
  caller: EntryCaller;
  query?: EntryQuery;
  regionalDirectorEastDisplay?: string | null;
  regionalDirectorWestDisplay?: string | null;
};

type EntryResponse = {
  status: number;
  body: any;
};

export async function getOverview({
  supa,
  today,
  now,
  fiscalYear,
  caller,
  query = {},
  regionalDirectorEastDisplay = null,
  regionalDirectorWestDisplay = null,
}: EntryArgs): Promise<EntryResponse> {
  let account = (query.account || "").trim();
  const previewParam = (query.preview || "").trim();
  const includeSalaryReq = query.include_salary === "1" || query.include_salary === true;
  const debug = (query.debug || "").trim().toLowerCase();
  const debugTiming = debug === "timing";

  // Preview target validation (mirrors purchasing route). Silent-ignore
  // an unknown preview matches resolvePreviewAccess's safety spirit.
  const previewIsValidTarget = previewParam && (
    isKnownAccount(previewParam) || V6_PSEUDO_KEYS.has(previewParam)
  );
  const preview = resolvePreviewAccess({
    caller,
    canViewAccount,
    urlAccount: account,
    previewParam: previewIsValidTarget ? previewParam : "",
  });
  account = preview.account;
  const preview_account = preview.preview_account;

  const landing_account = landingAccount(caller);

  // No account -> landing response (matches labor's shape).
  if (!account) {
    return {
      status: 200,
      body: { landing_account, preview_account, todayISO: today },
    };
  }
  if (account === "CORP") {
    return { status: 400, body: { error: "account_out_of_scope", account } };
  }

  // Locked-state response for accounts the caller cannot view.
  if (!canViewAccount(caller, account)) {
    return {
      status: 200,
      body: {
        locked: true,
        account,
        reason: "not_authorised",
        landing_account,
        preview_account,
        todayISO: today,
      },
    };
  }

  // Role gate for salary. The resolver receives the account-aware
  // value (not the raw caller.can_see_salary) so its internal check at
  // src/lib/kpi/overview/resolver.ts (`salaryAvailable: caller?.can_see_salary === true`)
  // matches the fetch.
  const salaryAvailable = canSeeSalary(caller, account);
  const includeSalary = includeSalaryReq && salaryAvailable;

  // Range resolution.
  let parsed;
  try { parsed = parseRange(query, today, fiscalYear); }
  catch (e) { return { status: 400, body: safeError("range", e) }; }
  const { snap } = parsed;
  const range = snap.kind === "fytd"
    ? { kind: "fytd" }
    : snap.kind === "period"
      ? { kind: "period", period_no: snap.period_no }
      : { kind: "explicit", start: snap.start, end: snap.end };

  // Resolve the Overview payload.
  let payload;
  try {
    payload = await resolveOverview({
      supa,
      accountKey: account,
      range,
      includeSalary,
      caller: { ...caller, can_see_salary: salaryAvailable },
      today,
      now,
      fy: fiscalYear,
      debugTiming,
      regionalDirectorEastDisplay,
      regionalDirectorWestDisplay,
    });
  } catch (e) {
    return { status: 500, body: safeError("resolve_overview", e) };
  }
  if (payload?.error) {
    return { status: 500, body: safeError(payload.scope || "resolve_overview", payload.error) };
  }
  payload.preview_account = preview_account;
  payload.landing_account = landing_account;
  if (caller?.role === "corporate") {
    payload.export = { available: true, scope: "all" };
  } else if (caller?.role === "site_leader" && caller.scope) {
    payload.export = { available: true, scope: caller.scope };
  } else {
    payload.export = { available: false };
  }
  if (snap.snapped) {
    payload.range_snap = {
      snapped: true,
      snapped_from: snap.snapped_from,
      snapped_to: { start: snap.start, end: snap.end, period_no: snap.period_no },
    };
  }
  payload.todayISO = today;
  return { status: 200, body: payload };
}
