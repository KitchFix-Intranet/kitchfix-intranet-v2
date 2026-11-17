// src/lib/kpi/entry.ts
//
// Train 2a: the engine's one public door. Replaces v1's
// `src/app/api/kpi/overview/route.js` for every outcome that lives
// inside the move's fence.
//
// The entry does what v1's GET handler does from line 111 to line
// 298 of route.js, in the same order, with the same outcomes:
//   - preview narrowing (resolvePreviewAccess)
//   - no-account landing answer
//   - CORP refusal
//   - not-authorised answer (canViewAccount)
//   - salary gate (canSeeSalary / include_salary)
//   - parseRange (?range=fytd / ?range=period:N / snapRange)
//   - resolveOverview
//   - the fields v1 adds afterwards: preview_account, landing_account,
//     export, range_snap, todayISO
//
// It does NOT do:
//   - the session or the preview-allowlist fence (left behind in v1;
//     the signed-in person comes from V2's shared viewer in a later
//     train)
//   - the role lookup (the caller is an input)
//   - the TEST_MODE / _test_role / _test_scope local backdoor (that
//     switch was standing in for the caller input this function
//     already takes)
//   - the `no-store` HTTP headers (v1's wrapper sets them; this
//     function returns plain data)
//
// Inputs:
//   supa                           DB client, passed in. The engine
//                                  never builds one and never reads
//                                  process.env.
//   today                          YYYY-MM-DD, passed in. The entry
//                                  never reads the clock.
//   caller                         { role, scope, can_see_salary }.
//                                  Null means not authorised.
//   query                          what v1 reads from the query string:
//                                  { account, preview, include_salary,
//                                    debug, range, start, end }.
//   regionalDirectorEastDisplay    display name for the East RDO. v1
//                                  derived this from an email address
//                                  it imported from
//                                  src/lib/incidentSchema.js. Both
//                                  default null; the folio suppresses
//                                  the subline on null.
//   regionalDirectorWestDisplay    display name for the West RDO.
//
// Returns: { status, body } as plain data. v1's wrapper would decide
// cache headers on top.

import { resolvePreviewAccess } from "./previewAccess";
import { canViewAccount, canSeeSalary, landingAccount } from "./roleGate";
import { isKnownAccount } from "./accountModels";
import { resolveOverview } from "./overview/resolver";
import { snapRange } from "./rangeSnap";
import { periodStartISO, periodEndISO } from "./labor/periods";

const V6_PSEUDO_KEYS = new Set(["ALL", "EAST", "WEST"]);

function safeError(scope: string, err: any) {
  // The engine's one source of the server-error shape. Matches
  // v1 route.js `safeError` verbatim apart from the log line, which
  // belongs to the HTTP layer and is not emitted here.
  return { error: "server_error", scope };
}

// parseRange mirrors v1 route.js:58-84. The caller supplies the four
// query-string pieces as plain strings; the entry does not read the
// URL itself.
function parseRange({ range = "", start = "", end = "" }: { range?: string; start?: string; end?: string }, today: string) {
  const rangeParam = range.trim();
  const startParam = start.trim();
  const endParam = end.trim();
  if (rangeParam === "fytd") return { snap: snapRange("", "", today), rangeParamSeen: "fytd" };
  if (rangeParam.startsWith("period:")) {
    const n = Number(rangeParam.slice("period:".length));
    if (Number.isInteger(n) && n >= 1 && n <= 13) {
      return {
        snap: {
          start: periodStartISO(n), end: periodEndISO(n),
          kind: "period", period_no: n,
          start_period_no: n, end_period_no: n,
          snapped: false, snapped_from: null,
        },
      };
    }
  }
  return { snap: snapRange(startParam, endParam, today) };
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
  try { parsed = parseRange(query, today); }
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
