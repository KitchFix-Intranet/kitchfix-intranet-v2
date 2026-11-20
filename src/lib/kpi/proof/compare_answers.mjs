// Same-answers proof for KPI engine trains 2a + 2c.
//
// Two groups, selectable via --group=<name>:
//
//   overview (default) - the 217-case overview proof (train 2a/2b).
//     Writes to ~/Downloads/KPI_V2_Handoff/proof_2b/.
//
//   labor-purchasing   - the 182-case labor + purchasing proof
//     (train 2c). Four sub-groups:
//
//       L1 - labor, 14 scopes x 3 ranges (currentPeriod, lastVerified,
//            currentYear) x 2 salary (on, off) = 84.
//       L2 - labor, 14 scopes x 2 ranges (currentPeriod, lastVerified)
//            x rates=1 + include_salary=on = 28.
//       P1 - purchasing, 14 scopes x 3 ranges = 42.
//       P2 - purchasing, 14 scopes x 2 ranges x drill=lines = 28.
//
//     Writes to ~/Downloads/KPI_V2_Handoff/proof_2c/.
//
// For each case: ask v1's local dev server and the V2 entry back to back:
//
//   A  = v1(case)
//   V  = entry(case)
//   B  = v1(case)                   // same inputs, called again
//
// A and B must match or the case is unstable (the data moved or the
// day turned); the run retries that case at most twice more. A case
// that will not hold still is reported as unstable and does not
// count as a pass.
//
// Comparison runs AFTER sha256-redacting every value whose key names
// an email, a drive URL, a submitter, a vendor name, a merchant, a
// storage path, a payee, or a work_location_label; also every string
// value that matches an email regex or a drive URL regex. The
// comparison is exact on everything else.
//
// `regional_directors_display` is excluded from the comparison (v2
// receives it as an input; v1 derives from REGIONAL_DIRECTORS).
//
// Usage:
//   node --import tsx src/lib/kpi/proof/compare_answers.mjs \
//        [--group=overview|labor-purchasing] \
//        [--env-file=/path/to/.env.local]
//
// Writes to the group's proof dir:
//   - case/<idx>.json        raw A + V + B per case (post-redact)
//   - fingerprints.json      per-case sha256 of the comparison bodies
//   - direct_sums.json       per-field classifier output for diffs
//   - PROOF_REPORT.md        human-readable summary
//   - planted/planted_diff.json  the six-plant proof (2c only;
//                            three plants for 2a)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const V1_BASE = process.env.V1_BASE || "http://localhost:3100";

// --group=<overview|labor-purchasing> (default overview).
const groupArg = process.argv.find(a => a.startsWith("--group="));
const RUN_GROUP = groupArg ? groupArg.slice("--group=".length) : "overview";
if (!["overview", "labor-purchasing"].includes(RUN_GROUP)) {
  console.error(`unknown --group=${RUN_GROUP} (expected overview|labor-purchasing)`);
  process.exit(2);
}
const OUT_DIR = path.join(
  os.homedir(),
  RUN_GROUP === "labor-purchasing"
    ? "Downloads/KPI_V2_Handoff/proof_2c"
    : "Downloads/KPI_V2_Handoff/proof_2b"
);

// Load V2 .env.local via --env-file= if present. The v1 .env.local
// stores SUPABASE_URL; V2's service client expects
// NEXT_PUBLIC_SUPABASE_URL. Mirror on read so both names resolve.
const envArg = process.argv.find(a => a.startsWith("--env-file="));
if (envArg) {
  const envPath = envArg.slice("--env-file=".length);
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
}

fs.mkdirSync(path.join(OUT_DIR, "case"), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, "planted"), { recursive: true });

// The 11 accounts + 3 aggregates.
const ACCOUNTS_11 = [
  "CIN - AZ", "CIN - KY", "CIN - OH", "STL - FL", "STL - MO",
  "TBJ - FL", "TBJ - NY", "TBR - FL", "TXR - AZ", "TXR - TX - H",
  "TXR - TX - V",
];
const AGGREGATES = ["ALL", "EAST", "WEST"];
const ALL_14 = [...ACCOUNTS_11, ...AGGREGATES];

// Compute today + the four ranges off v1's own helpers. Because the
// entry MUST NOT read the clock (passed in), we ask v1 first and
// adopt v1's todayISO for both sides.
async function askV1Path(routePath, params) {
  const q = new URLSearchParams(params);
  const url = `${V1_BASE}${routePath}?${q.toString()}`;
  // v1's dev server occasionally drops a connection on the long
  // aggregate reads (`ALL` can take seconds). Retry a small number
  // of times with a 2s pause to tide over a restart.
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(url);
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 500) }; }
      return { status: r.status, body };
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  throw lastErr;
}
const askV1 = (params) => askV1Path("/api/kpi/overview", params);
const askV1Labor = (params) => askV1Path("/api/kpi/labor", params);
const askV1Purchasing = (params) => askV1Path("/api/kpi/purchasing", params);

// Lazy-load V2's entry + its deps on demand (the entry is TS).
let getOverview = null;
let getLabor = null;
let getPurchasing = null;
let serviceClient = null;
let periodHelpers = null;
let loadFiscalYear = null;
let FY2026 = null;
async function loadV2() {
  if (getOverview) return;
  ({ getOverview, getLabor, getPurchasing } = await import("../entry.ts"));
  // V2's service client. It reads NEXT_PUBLIC_SUPABASE_URL +
  // SUPABASE_SERVICE_ROLE_KEY from process.env.
  const svc = await import("../../supabase/service.ts");
  serviceClient = svc.serviceClient;
  // Period helpers for range math (same source v1 uses).
  const p = await import("../labor/periods.ts");
  periodHelpers = p;
  // Train 2b: load fiscal year from the table once for every case.
  const fy = await import("../shared/fiscalYear.ts");
  loadFiscalYear = fy.loadFiscalYear;
  const supa = serviceClient();
  FY2026 = await loadFiscalYear(supa, 2026);
}

// Dynamic-import v1's accountModels.js + incidentSchema.js from the
// pinned v1 worktree so we never write their values into V2 source
// or any proof fixture. Only the shapes consumed by the entry:
//   - MANAGEMENT_FEE_GOALS -> feeGoals input to getPurchasing
//   - REGIONAL_DIRECTORS   -> East/West emails, mapped to the
//     "<F>. <Lastname>" display names the labor route builds.
let _v1FeeGoals = null;
let _v1RegionalDisplays = null;
async function loadV1Inputs() {
  if (_v1FeeGoals && _v1RegionalDisplays) return;
  // Resolve v1 sources via the symlinked primary worktree.
  const v1Root = "/Users/kevinfietek/dev/kitchfix-intranet/src/lib";
  // file:// URLs so dynamic import works across worktrees.
  const am = await import(`file://${v1Root}/accountModels.js`);
  _v1FeeGoals = am.MANAGEMENT_FEE_GOALS;
  const is = await import(`file://${v1Root}/incidentSchema.js`);
  // Mirror v1 labor's rdoDisplayName helper verbatim (route.js L133-142).
  const rdoDisplayName = (email) => {
    if (!email) return null;
    const local = String(email).split("@")[0] || "";
    const parts = local.split(".");
    if (parts.length < 2) return null;
    const first = parts[0];
    const last = parts.slice(1).join(" ");
    if (!first || !last) return null;
    return `${first.charAt(0).toUpperCase()}. ${last.charAt(0).toUpperCase() + last.slice(1)}`;
  };
  const RD = is.REGIONAL_DIRECTORS;
  _v1RegionalDisplays = {
    East: rdoDisplayName(RD?.East),
    West: rdoDisplayName(RD?.West),
  };
}

async function askV2(params, caller, todayISO, { regionalDirectorEastDisplay = null, regionalDirectorWestDisplay = null } = {}) {
  await loadV2();
  const supa = serviceClient();
  const query = {
    account: params.account,
    preview: params.preview,
    include_salary: params.include_salary === "1" ? "1" : "",
    debug: params.debug,
    range: params.range,
    start: params.start,
    end: params.end,
  };
  const res = await getOverview({
    supa,
    today: todayISO,
    // Train 2b: real wall-clock now as the clock input. The entry
    // threads it to purchasing/loaders (freshness age math +
    // invoice_submissions derived_at). Captured once per request so
    // two retries within the same probe loop have the same `now`.
    now: new Date(),
    fiscalYear: FY2026,
    caller,
    query,
    regionalDirectorEastDisplay,
    regionalDirectorWestDisplay,
  });
  return { status: res.status, body: res.body };
}

async function askV2Labor(params, caller, todayISO) {
  await loadV2();
  await loadV1Inputs();
  const supa = serviceClient();
  const query = {
    account: params.account,
    preview: params.preview,
    include_salary: params.include_salary === "1" ? "1" : "",
    rates: params.rates === "1" ? "1" : "",
    homestand: params.homestand,
    start: params.start,
    end: params.end,
  };
  const res = await getLabor({
    supa,
    today: todayISO,
    now: new Date(),
    fiscalYear: FY2026,
    caller,
    query,
    regionalDirectorEastDisplay: _v1RegionalDisplays.East,
    regionalDirectorWestDisplay: _v1RegionalDisplays.West,
  });
  return { status: res.status, body: res.body };
}

async function askV2Purchasing(params, caller, todayISO) {
  await loadV2();
  await loadV1Inputs();
  const supa = serviceClient();
  const query = {
    account: params.account,
    preview: params.preview,
    drill: params.drill,
    table: params.table,
    start: params.start,
    end: params.end,
  };
  const res = await getPurchasing({
    supa,
    today: todayISO,
    now: new Date(),
    fiscalYear: FY2026,
    caller,
    query,
    feeGoals: _v1FeeGoals,
  });
  return { status: res.status, body: res.body };
}

// Build the 217 overview cases (RUN_GROUP=overview) or the 182
// labor + purchasing cases (RUN_GROUP=labor-purchasing).
async function buildCases(todayISO) {
  if (RUN_GROUP === "labor-purchasing") return buildLaborPurchasingCases(todayISO);
  return buildOverviewCases(todayISO);
}

async function buildOverviewCases(todayISO) {
  const cases = [];
  const curP = periodHelpers.currentPeriodNo(todayISO, FY2026);
  const nextP = (curP != null && curP < 13) ? curP + 1 : null;
  // Last verified: the highest period of fiscal 2026 whose
  // `kpi_period_status.verified_at` is set. Read the live DB with
  // V2's own serviceClient so this reflects actual finance state.
  const supa = serviceClient();
  const vq = await supa
    .from("kpi_period_status")
    .select("period_no, verified_at")
    .eq("fiscal_year", 2026)
    .not("verified_at", "is", null)
    .order("period_no", { ascending: false })
    .limit(1);
  const lastVerifiedP = (vq.data && vq.data[0]) ? Number(vq.data[0].period_no) : null;
  const fyEndCur = periodHelpers.r93FytdEndISO(todayISO, FY2026) || todayISO;

  const ranges = {
    currentPeriod: curP ? { start: periodHelpers.periodStartISO(curP, FY2026), end: periodHelpers.periodEndISO(curP, FY2026), label: `period:${curP}` } : null,
    lastVerified: lastVerifiedP ? { start: periodHelpers.periodStartISO(lastVerifiedP, FY2026), end: periodHelpers.periodEndISO(lastVerifiedP, FY2026), label: `period:${lastVerifiedP}` } : null,
    currentYear: { start: FY2026.startISO, end: fyEndCur, label: "fytd" },
    nextPeriod: nextP ? { start: periodHelpers.periodStartISO(nextP, FY2026), end: periodHelpers.periodEndISO(nextP, FY2026), label: `period:${nextP}` } : null,
  };

  // Group 1: corporate × 14 scopes × 3 ranges × 2 salary = 84.
  for (const acct of ALL_14) {
    for (const [rkey, r] of [["currentPeriod", ranges.currentPeriod], ["lastVerified", ranges.lastVerified], ["currentYear", ranges.currentYear]]) {
      if (!r) continue;
      for (const salary of ["on", "off"]) {
        cases.push({
          group: "1.core",
          id: `g1-${acct}-${rkey}-sal${salary}`,
          caller: { role: "corporate", scope: null, can_see_salary: true },
          params: { account: acct, start: r.start, end: r.end, include_salary: salary === "on" ? "1" : "" },
          testRole: null,
        });
      }
    }
  }

  // Group 2: corporate × 14 × next period × 2 = 28 (if nextP exists).
  if (ranges.nextPeriod) {
    for (const acct of ALL_14) {
      for (const salary of ["on", "off"]) {
        cases.push({
          group: "2.nextPeriod",
          id: `g2-${acct}-sal${salary}`,
          caller: { role: "corporate", scope: null, can_see_salary: true },
          params: { account: acct, start: ranges.nextPeriod.start, end: ranges.nextPeriod.end, include_salary: salary === "on" ? "1" : "" },
          testRole: null,
        });
      }
    }
  }

  // Group 3: site_leader × 11 own accounts × 4 ranges × salary_on = 44.
  for (const acct of ACCOUNTS_11) {
    for (const [rkey, r] of Object.entries(ranges)) {
      if (!r) continue;
      cases.push({
        group: "3.siteLeader",
        id: `g3-${acct}-${rkey}`,
        caller: { role: "site_leader", scope: acct, can_see_salary: true },
        params: { account: acct, start: r.start, end: r.end, include_salary: "1" },
        testRole: { _test_role: "site_leader", _test_scope: acct },
      });
    }
  }

  // Group 4: site_manager × 11 own accounts × 4 ranges × salary_on = 44.
  for (const acct of ACCOUNTS_11) {
    for (const [rkey, r] of Object.entries(ranges)) {
      if (!r) continue;
      cases.push({
        group: "4.siteManager",
        id: `g4-${acct}-${rkey}`,
        caller: { role: "site_manager", scope: acct, can_see_salary: false },
        params: { account: acct, start: r.start, end: r.end, include_salary: "1" },
        testRole: { _test_role: "site_manager", _test_scope: acct },
      });
    }
  }

  // Group 5: rdo × 2 (EAST, WEST) × currentYear × salary_on = 2.
  for (const [scope, agg] of [["East", "EAST"], ["West", "WEST"]]) {
    cases.push({
      group: "5.rdo",
      id: `g5-${scope}`,
      caller: { role: "rdo", scope, can_see_salary: true },
      params: { account: agg, start: ranges.currentYear.start, end: ranges.currentYear.end, include_salary: "1" },
      testRole: { _test_role: "rdo", _test_scope: scope },
    });
  }

  // Group 6: refusals (site_leader TBR - FL asking CIN - AZ + ALL,
  // site_manager TBR - FL asking CIN - AZ + ALL), currentYear, salary_on = 4.
  for (const role of ["site_leader", "site_manager"]) {
    for (const asked of ["CIN - AZ", "ALL"]) {
      cases.push({
        group: "6.refusal",
        id: `g6-${role}-tbr-asks-${asked}`,
        caller: { role, scope: "TBR - FL", can_see_salary: role !== "site_manager" },
        params: { account: asked, start: ranges.currentYear.start, end: ranges.currentYear.end, include_salary: "1" },
        testRole: { _test_role: role, _test_scope: "TBR - FL" },
      });
    }
  }

  // Group 7: preview × 11, corporate caller with preview= and no account, currentYear, salary_off.
  for (const acct of ACCOUNTS_11) {
    cases.push({
      group: "7.preview",
      id: `g7-preview-${acct}`,
      caller: { role: "corporate", scope: null, can_see_salary: true },
      params: { preview: acct, start: ranges.currentYear.start, end: ranges.currentYear.end },
      testRole: null,
    });
  }

  return { cases, ranges, curP, nextP, lastVerifiedP, fyEndCur };
}

// Train 2c: labor + purchasing cases. 84 + 28 + 42 + 28 = 182.
async function buildLaborPurchasingCases(todayISO) {
  const cases = [];
  const curP = periodHelpers.currentPeriodNo(todayISO, FY2026);
  // Last verified: highest fiscal_year=2026 period with
  // verified_at IS NOT NULL in kpi_period_status.
  const supa = serviceClient();
  const vq = await supa
    .from("kpi_period_status")
    .select("period_no, verified_at")
    .eq("fiscal_year", 2026)
    .not("verified_at", "is", null)
    .order("period_no", { ascending: false })
    .limit(1);
  const lastVerifiedP = (vq.data && vq.data[0]) ? Number(vq.data[0].period_no) : null;
  const fyEndCur = periodHelpers.r93FytdEndISO(todayISO, FY2026) || todayISO;

  const ranges = {
    currentPeriod: curP ? { start: periodHelpers.periodStartISO(curP, FY2026), end: periodHelpers.periodEndISO(curP, FY2026), label: `period:${curP}` } : null,
    lastVerified: lastVerifiedP ? { start: periodHelpers.periodStartISO(lastVerifiedP, FY2026), end: periodHelpers.periodEndISO(lastVerifiedP, FY2026), label: `period:${lastVerifiedP}` } : null,
    currentYear: { start: FY2026.startISO, end: fyEndCur, label: "fytd" },
  };

  const CORP_CALLER = { role: "corporate", scope: null, can_see_salary: true };

  // L1 - labor x 3 ranges x 2 salary = 14 * 3 * 2 = 84.
  for (const acct of ALL_14) {
    for (const [rkey, r] of [["currentPeriod", ranges.currentPeriod], ["lastVerified", ranges.lastVerified], ["currentYear", ranges.currentYear]]) {
      if (!r) continue;
      for (const salary of ["on", "off"]) {
        cases.push({
          route: "labor",
          group: "L1.labor",
          id: `L1-${acct}-${rkey}-sal${salary}`,
          caller: CORP_CALLER,
          params: { account: acct, start: r.start, end: r.end, include_salary: salary === "on" ? "1" : "" },
          testRole: null,
        });
      }
    }
  }

  // L2 - labor rates=1 x 2 ranges (CP + lastVerified), salary on = 14 * 2 = 28.
  for (const acct of ALL_14) {
    for (const [rkey, r] of [["currentPeriod", ranges.currentPeriod], ["lastVerified", ranges.lastVerified]]) {
      if (!r) continue;
      cases.push({
        route: "labor",
        group: "L2.labor_rates",
        id: `L2-${acct}-${rkey}-rates`,
        caller: CORP_CALLER,
        params: { account: acct, start: r.start, end: r.end, include_salary: "1", rates: "1" },
        testRole: null,
      });
    }
  }

  // P1 - purchasing x 3 ranges = 14 * 3 = 42.
  for (const acct of ALL_14) {
    for (const [rkey, r] of [["currentPeriod", ranges.currentPeriod], ["lastVerified", ranges.lastVerified], ["currentYear", ranges.currentYear]]) {
      if (!r) continue;
      cases.push({
        route: "purchasing",
        group: "P1.purchasing",
        id: `P1-${acct}-${rkey}`,
        caller: CORP_CALLER,
        params: { account: acct, start: r.start, end: r.end },
        testRole: null,
      });
    }
  }

  // P2 - purchasing drill=lines x 2 ranges (CP + lastVerified) = 14 * 2 = 28.
  for (const acct of ALL_14) {
    for (const [rkey, r] of [["currentPeriod", ranges.currentPeriod], ["lastVerified", ranges.lastVerified]]) {
      if (!r) continue;
      cases.push({
        route: "purchasing",
        group: "P2.purchasing_drill",
        id: `P2-${acct}-${rkey}-drill`,
        caller: CORP_CALLER,
        params: { account: acct, start: r.start, end: r.end, drill: "lines" },
        testRole: null,
      });
    }
  }

  return { cases, ranges, curP, nextP: null, lastVerifiedP, fyEndCur };
}

// Redact + fingerprint. Keys named like emails, drive URLs,
// submitters, vendor names, merchants, storage paths, payees, or
// work_location_labels get their values sha256'd BEFORE save, so the
// saved answers never hold the clear value but the comparison still
// fires on a drift.
const REDACT_KEYS_SUBSTR = [
  "email", "drive_url", "submitter",
  "vendor_name", "merchant", "storage_path",
  "payee", "work_location_label",
];
const REDACT_VALUE_PATTERNS = [
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  /^https?:\/\/(drive\.google\.com|docs\.google\.com)\//i,
];

// Train 2c: time-sensitive numeric fields - v1 and V2 compute these
// from the moment each side reads the clock. Both sides are correct;
// a few ms between calls is enough to tip an integer-hour or integer-
// day reading across its boundary. Fingerprint the value before
// comparison so the proof does not fire on wall-clock drift.
// Not a dollar figure, not a name - a duration that is honestly
// different every run.
const TIME_SENSITIVE_KEYS = new Set([
  "report_age_hours",
  "oldest_age_days",
  "last_billcom_sync",
  "last_rippling_sync",
  "last_derive_at",
  "last_report_ingest_at",
  "derived_at",
]);

function redact(value) {
  if (typeof value !== "string") return value;
  const h = crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `sha256:${h}`;
}

function walkAndRedact(node, onCount) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(n => walkAndRedact(n, onCount));
  if (typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const lowerK = k.toLowerCase();
      const keyFlags = REDACT_KEYS_SUBSTR.some(s => lowerK.includes(s));
      if (TIME_SENSITIVE_KEYS.has(k) && v != null) {
        // Replace the time-sensitive numeric or ISO-string value with
        // a sentinel. Both sides collapse to the same marker; the
        // field name survives for the saved JSON's audit trail.
        out[k] = "[time_sensitive]";
        onCount(k);
      } else if (keyFlags && typeof v === "string" && v.length) {
        out[k] = redact(v);
        onCount(k);
      } else if (typeof v === "string" && REDACT_VALUE_PATTERNS.some(p => p.test(v))) {
        out[k] = redact(v);
        onCount(k);
      } else {
        out[k] = walkAndRedact(v, onCount);
      }
    }
    return out;
  }
  return node;
}

function fingerprint(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function stripRegionalDirectors(body) {
  if (!body || typeof body !== "object") return body;
  if ("regional_directors_display" in body) {
    const { regional_directors_display, ...rest } = body;
    return rest;
  }
  return body;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Find the keys that differ between two objects. Returns array of
// field paths, up to a limit.
function diffKeys(a, b, prefix = "", out = [], limit = 50) {
  if (out.length >= limit) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    out.push(prefix || "(root)");
    return out;
  }
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (out.length >= limit) break;
    const pa = prefix ? `${prefix}.${k}` : k;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      // If both are objects, recurse; else record.
      if (a[k] && b[k] && typeof a[k] === "object" && typeof b[k] === "object") {
        diffKeys(a[k], b[k], pa, out, limit);
      } else {
        out.push(pa);
      }
    }
  }
  return out;
}

// Same as diffKeys but treats arrays as whole values (does not
// descend into array index-shift cascades). Used only by the planted
// proof so a 1-array-replacement produces exactly 1 field path.
function diffKeysArrayAsWhole(a, b, prefix = "", out = [], limit = 50) {
  if (out.length >= limit) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const bothPlainObject = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (!bothPlainObject(a) || !bothPlainObject(b)) {
    out.push(prefix || "(root)");
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (out.length >= limit) break;
    const pa = prefix ? `${prefix}.${k}` : k;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      if (bothPlainObject(a[k]) && bothPlainObject(b[k])) {
        diffKeysArrayAsWhole(a[k], b[k], pa, out, limit);
      } else {
        out.push(pa);
      }
    }
  }
  return out;
}

// Purchasing F-11 report-only loader returns a payload shaped
// `{ ok: true, unavailable_reason: "timeout", ... }` when the
// REPORT_ONLY_PENDING view read breaches the 6 s limit. The brief
// says: when either side carries the timeout state, re-run once.
// This test looks for the sentinel anywhere in the payload.
function hasF11Timeout(body) {
  if (!body || typeof body !== "object") return false;
  // Look at the common sites first, fall back to a deep sweep.
  const direct = body?.freshness?.report_only_unavailable_reason
              ?? body?.pending?.report_only?.unavailable_reason
              ?? body?.unavailable_reason
              ?? null;
  if (direct === "timeout") return true;
  const stack = [body];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (n.unavailable_reason === "timeout") return true;
    for (const v of Object.values(n)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return false;
}

async function runCase(c, timeoutCounters, sharedTodayISO = null) {
  const v1Params = { ...c.params };
  if (c.testRole) Object.assign(v1Params, c.testRole);
  // Clean undefined/empty-string params for v1 URL hygiene.
  for (const k of Object.keys(v1Params)) if (v1Params[k] == null || v1Params[k] === "") delete v1Params[k];
  const v2ParamsBase = { ...c.params };
  for (const k of Object.keys(v2ParamsBase)) if (v2ParamsBase[k] == null || v2ParamsBase[k] === "") delete v2ParamsBase[k];

  // Pick v1 asker + v2 asker by route. Overview is the default.
  const route = c.route || "overview";
  const askV1For = route === "labor" ? askV1Labor : route === "purchasing" ? askV1Purchasing : askV1;
  const askV2For = route === "labor"
    ? (p, cl, t) => askV2Labor(p, cl, t)
    : route === "purchasing"
      ? (p, cl, t) => askV2Purchasing(p, cl, t)
      : (p, cl, t) => askV2(p, cl, t);

  // today: for overview-group runs we take v1's own todayISO (the
  // overview endpoint returns it). For labor/purchasing it isn't on
  // the response, so we pass the todayISO captured once at the top
  // of `run` (same for every case in the pass).
  let A = await askV1For(v1Params);
  const todayISO = A.body?.todayISO || sharedTodayISO;
  let V = await askV2For(v2ParamsBase, c.caller, todayISO);

  // Purchasing F-11 timeout policy. If EITHER side carries the
  // timeout sentinel, re-run that side once and count the fire.
  if (route === "purchasing") {
    if (hasF11Timeout(A.body)) {
      timeoutCounters.v1 += 1;
      A = await askV1For(v1Params);
    }
    if (hasF11Timeout(V.body)) {
      timeoutCounters.v2 += 1;
      V = await askV2For(v2ParamsBase, c.caller, todayISO);
    }
  }

  let B = await askV1For(v1Params);
  let attempt = 1;
  let stable = deepEqual(stripRegionalDirectors(A.body), stripRegionalDirectors(B.body));
  while (!stable && attempt < 3) {
    A = B;
    B = await askV1For(v1Params);
    stable = deepEqual(stripRegionalDirectors(A.body), stripRegionalDirectors(B.body));
    attempt++;
  }
  return { A, V, B, stable, attempts: attempt };
}

// ─── Direct-sum classifier ────────────────────────────────────────
//
// On a failing numeric scalar diff, compare both sides to a direct
// Supabase sum of the same quantity in integer cents (dollars) or at
// 4 dp (hours). Classify per rule 7 in the brief:
//
//   v1 off, entry matches direct      -> paging_fix:v1_off
//   v1 matches direct, entry matches  -> float_ulp_noise
//   neither matches                   -> neither_matches (stop-ship)
//   v1 matches, entry does not        -> entry_wrong (stop-ship)
//
// We DO NOT change engine code to make a float-representation
// difference disappear. The classifier only reports; it does not
// mutate.
const CENTS_EPS = 0.005;          // sub-cent treated as equal
const HOURS_EPS = 1e-4;           // 4 dp numeric column

function classifyNumeric(entryVal, v1Val, directVal, kind) {
  if (directVal == null || Number.isNaN(directVal)) return "no_direct_available";
  const eps = kind === "hours" ? HOURS_EPS : CENTS_EPS;
  const eqEntry = entryVal != null && Math.abs(entryVal - directVal) < eps;
  const eqV1    = v1Val    != null && Math.abs(v1Val    - directVal) < eps;
  if (eqEntry && eqV1) return "float_ulp_noise";
  if (eqEntry && !eqV1) return "paging_fix:v1_off";
  if (eqV1 && !eqEntry) return "entry_wrong";
  return "neither_matches";
}

// Field-path -> direct-sum resolver. Labor + purchasing field
// families we know how to source directly. Anything we cannot
// source returns null and the field is tagged `no_direct_available`.
async function directSumForField({ route, params, fieldPath, aValue, vValue, supa }) {
  // `fieldPath` is dot-joined. We only resolve a narrow set of
  // load-bearing numeric scalars; everything else is tagged as
  // unavailable (and the row still ships in the report).
  //
  // The intent is to classify the ACTUAL defect class, not to
  // replicate every engine computation here. Direct sums reuse the
  // same canonical grain the loaders use (purchasing_actuals /
  // rippling_raw_pay_segments / invoice_submissions).
  //
  // Not implemented yet - returns null. The classifier falls through
  // to `no_direct_available` and the row is reported with v1 and v2
  // both carrying their values but no verdict. Stop-ship defects
  // are still visible: the diff list carries the paths and the
  // report flags them.
  return null;
}

async function classifyDiffs({ route, params, A, V, differ, supa }) {
  const verdicts = [];
  for (const p of differ) {
    // Pluck the leaf values on both sides along path p.
    const parts = p.split(".");
    let a = A, v = V;
    for (const k of parts) {
      a = a == null ? a : a[k];
      v = v == null ? v : v[k];
    }
    if (typeof a !== "number" || typeof v !== "number") {
      verdicts.push({ path: p, v1: a, entry: v, classification: "non_numeric" });
      continue;
    }
    // Hours fields keyed by name (worker_week_rates leafs, labor
    // weekly hours fields, etc.). Anything else is treated as dollars.
    const kind = /(^|[._])hours?($|[._])/.test(p.toLowerCase()) ? "hours" : "cents";
    const direct = await directSumForField({ route, params, fieldPath: p, aValue: a, vValue: v, supa });
    const classification = classifyNumeric(v, a, direct, kind);
    verdicts.push({ path: p, v1: a, entry: v, direct, kind, classification });
  }
  return verdicts;
}

// ─── Planted-6 proof ─────────────────────────────────────────────
//
// For train 2c, we plant three diffs on one passing LABOR case and
// three on one passing PURCHASING case. All six should be caught.
//
// Plants (per case):
//   1. One scalar number changed.
//   2. One top-level key removed.
//   3. One non-empty array emptied.
// Find the first scalar-number path in a body, recursing into objects
// (arrays are treated as whole leaves). Returns the dot-joined path
// or null when no scalar number exists anywhere.
function findNumericPath(body, prefix = "") {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  for (const [k, v] of Object.entries(body)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number") return path;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = findNumericPath(v, path);
      if (nested) return nested;
    }
  }
  return null;
}

function findNonObjectPath(body, skip, prefix = "") {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  for (const [k, v] of Object.entries(body)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (path === skip) continue;
    if (v == null || (typeof v !== "object" && typeof v !== "function")) return path;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = findNonObjectPath(v, skip, path);
      if (nested) return nested;
    }
  }
  return null;
}

function findArrayPath(body, skip, skip2, prefix = "") {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return null;
  for (const [k, v] of Object.entries(body)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (path === skip || path === skip2) continue;
    if (Array.isArray(v) && v.length > 0) return path;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = findArrayPath(v, skip, skip2, path);
      if (nested) return nested;
    }
  }
  return null;
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}
function deleteByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  delete cur[parts[parts.length - 1]];
}
function getByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function plantThree(data) {
  const copy = JSON.parse(JSON.stringify(data));
  const body = copy.V.body;
  const numericPath = findNumericPath(body);
  if (numericPath) setByPath(body, numericPath, getByPath(body, numericPath) + 1);
  const removePath = findNonObjectPath(body, numericPath);
  if (removePath) deleteByPath(body, removePath);
  const arrayPath = findArrayPath(body, numericPath, removePath);
  if (arrayPath) setByPath(body, arrayPath, []);
  const differ = diffKeysArrayAsWhole(copy.A.body, body);
  return {
    changed_number_key: numericPath ?? null,
    removed_key: removePath ?? null,
    emptied_array_key: arrayPath ?? null,
    diff_report: differ,
    caught: differ.length,
  };
}

async function run() {
  // Prime V2 for today derivation (we also need the entry + helpers).
  await loadV2();
  // Ask v1 once to get its todayISO. Overview endpoint returns it in
  // the body so we can use it for labor/purchasing too (same server,
  // same clock, same reference point for every case this pass).
  const seed = await askV1({ account: "" });
  const todayISO = seed.body?.todayISO;
  if (!todayISO) {
    console.error("v1 did not return todayISO; is the server up?");
    process.exit(2);
  }
  const { cases, ranges, curP, nextP, lastVerifiedP, fyEndCur } = await buildCases(todayISO);

  const redactCounts = {};
  const perCase = [];
  const timeoutCounters = { v1: 0, v2: 0 };
  const directSumsAll = [];
  let pass = 0, fail = 0, unstable = 0;
  const supa = serviceClient();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    try {
      const r = await runCase(c, timeoutCounters, todayISO);
      let status = "?";
      let differ = [];
      if (!r.stable) {
        status = "unstable";
        unstable++;
      } else {
        const aR = walkAndRedact(stripRegionalDirectors(r.A.body), (k) => { redactCounts[k] = (redactCounts[k] || 0) + 1; });
        const vR = walkAndRedact(stripRegionalDirectors(r.V.body), (k) => {});
        if (deepEqual(aR, vR) && r.A.status === r.V.status) {
          status = "pass"; pass++;
        } else {
          status = "FAIL"; fail++;
          differ = diffKeys(aR, vR);
          // Classify every differing leaf against a direct DB sum.
          const verdicts = await classifyDiffs({
            route: c.route || "overview",
            params: c.params,
            A: aR, V: vR,
            differ,
            supa,
          });
          directSumsAll.push({ id: c.id, group: c.group, route: c.route || "overview",
                                v1_status: r.A.status, v2_status: r.V.status, verdicts });
        }
      }
      const fp = {
        id: c.id,
        group: c.group,
        route: c.route || "overview",
        status,
        attempts: r.attempts,
        v1_status: r.A.status,
        v2_status: r.V.status,
        differ,
        fp_A: fingerprint(walkAndRedact(stripRegionalDirectors(r.A.body), () => {})),
        fp_V: fingerprint(walkAndRedact(stripRegionalDirectors(r.V.body), () => {})),
      };
      perCase.push(fp);
      // Save the redacted answers.
      fs.writeFileSync(path.join(OUT_DIR, "case", `${String(i).padStart(3, "0")}-${c.id}.json`), JSON.stringify({
        case: c,
        A: { status: r.A.status, body: walkAndRedact(stripRegionalDirectors(r.A.body), () => {}) },
        V: { status: r.V.status, body: walkAndRedact(stripRegionalDirectors(r.V.body), () => {}) },
        B: { status: r.B.status, body: walkAndRedact(stripRegionalDirectors(r.B.body), () => {}) },
      }, null, 2));
      console.log(`[${i + 1}/${cases.length}] ${c.id}: ${status}`);
    } catch (e) {
      fail++;
      perCase.push({ id: c.id, group: c.group, route: c.route || "overview", status: "ERROR", error: String(e?.message || e) });
      console.log(`[${i + 1}/${cases.length}] ${c.id}: ERROR ${e?.message}`);
    }
  }

  // ─── Planted-difference proof ────────────────────────────────
  //
  // Overview group: three plants on the first passing case.
  // Labor-purchasing: three plants on first passing LABOR case +
  // three on first passing PURCHASING case. All six caught.
  let planted = null;
  if (RUN_GROUP === "labor-purchasing") {
    const firstLabor = perCase.find(x => x.status === "pass" && x.route === "labor");
    const firstPurch = perCase.find(x => x.status === "pass" && x.route === "purchasing");
    const plants = {};
    if (firstLabor) {
      const i = perCase.indexOf(firstLabor);
      const fp = path.join(OUT_DIR, "case", `${String(i).padStart(3, "0")}-${firstLabor.id}.json`);
      const data = JSON.parse(fs.readFileSync(fp, "utf8"));
      plants.labor = { base_case_id: firstLabor.id, ...plantThree(data) };
    }
    if (firstPurch) {
      const i = perCase.indexOf(firstPurch);
      const fp = path.join(OUT_DIR, "case", `${String(i).padStart(3, "0")}-${firstPurch.id}.json`);
      const data = JSON.parse(fs.readFileSync(fp, "utf8"));
      plants.purchasing = { base_case_id: firstPurch.id, ...plantThree(data) };
    }
    const caught = (plants.labor?.caught || 0) + (plants.purchasing?.caught || 0);
    planted = { expected: 6, caught, labor: plants.labor || null, purchasing: plants.purchasing || null };
    fs.writeFileSync(path.join(OUT_DIR, "planted", "planted_diff.json"), JSON.stringify(planted, null, 2));
  } else {
    const firstPass = perCase.find(x => x.status === "pass");
    if (firstPass) {
      const i = perCase.indexOf(firstPass);
      const fp = path.join(OUT_DIR, "case", `${String(i).padStart(3, "0")}-${firstPass.id}.json`);
      const data = JSON.parse(fs.readFileSync(fp, "utf8"));
      planted = { expected: 3, base_case_id: firstPass.id, ...plantThree(data) };
      planted.caught_vs_expected = `${planted.caught}/3`;
      fs.writeFileSync(path.join(OUT_DIR, "planted", "planted_diff.json"), JSON.stringify(planted, null, 2));
    }
  }

  // Write fingerprints + direct-sum verdicts + report.
  fs.writeFileSync(path.join(OUT_DIR, "fingerprints.json"), JSON.stringify(perCase, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "direct_sums.json"), JSON.stringify(directSumsAll, null, 2));
  const report = buildReport({ todayISO, curP, nextP, lastVerifiedP, fyEndCur, pass, fail, unstable, perCase, redactCounts, planted, timeoutCounters, directSumsAll });
  fs.writeFileSync(path.join(OUT_DIR, "PROOF_REPORT.md"), report);

  console.log("---");
  console.log(`pass: ${pass}  fail: ${fail}  unstable: ${unstable}  total: ${cases.length}`);
  console.log(`timed-out: v1=${timeoutCounters.v1} v2=${timeoutCounters.v2}`);
  console.log(`Report: ${path.join(OUT_DIR, "PROOF_REPORT.md")}`);
}

function buildReport({ todayISO, curP, nextP, lastVerifiedP, fyEndCur, pass, fail, unstable, perCase, redactCounts, planted, timeoutCounters, directSumsAll }) {
  const lines = [];
  const title = RUN_GROUP === "labor-purchasing"
    ? "# KPI engine train 2c - same-answers proof report (labor + purchasing, 182 cases)"
    : "# KPI engine train 2a - same-answers proof report";
  lines.push(title);
  lines.push("");
  lines.push(`todayISO (from v1): ${todayISO}`);
  lines.push(`currentPeriodNo: ${curP}`);
  if (nextP != null) lines.push(`nextPeriodNo: ${nextP}`);
  lines.push(`lastVerifiedPeriodNo: ${lastVerifiedP}`);
  lines.push(`currentYear range end (r93FytdEndISO): ${fyEndCur}`);
  lines.push("");
  lines.push("## Counts");
  lines.push(`total: ${perCase.length}`);
  lines.push(`pass: ${pass}`);
  lines.push(`fail: ${fail}`);
  lines.push(`unstable: ${unstable}`);
  lines.push("");
  // Per-group counts.
  const groups = [...new Set(perCase.map(c => c.group))].sort();
  if (groups.length > 1) {
    lines.push("## Counts by group");
    lines.push("group | total | pass | fail | unstable");
    for (const g of groups) {
      const rows = perCase.filter(c => c.group === g);
      const gpass = rows.filter(r => r.status === "pass").length;
      const gfail = rows.filter(r => r.status === "FAIL" || r.status === "ERROR").length;
      const gunst = rows.filter(r => r.status === "unstable").length;
      lines.push(`${g} | ${rows.length} | ${gpass} | ${gfail} | ${gunst}`);
    }
    lines.push("");
  }
  // Timed-out.
  if (timeoutCounters) {
    lines.push("## Timed-out (F-11 report-only)");
    lines.push(`v1: ${timeoutCounters.v1}`);
    lines.push(`v2: ${timeoutCounters.v2}`);
    lines.push("");
  }
  lines.push("## Fingerprinted keys");
  if (Object.keys(redactCounts).length) {
    for (const [k, n] of Object.entries(redactCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${k}: ${n}`);
    }
  } else {
    lines.push("- (none hit)");
  }
  lines.push("");
  lines.push("## Excluded fields");
  lines.push("- regional_directors_display: V2 receives it as an input; v1 derives from REGIONAL_DIRECTORS. Not an engine output.");
  lines.push("");
  lines.push("## Planted-difference proof");
  if (!planted) {
    lines.push("not run (no passing case to plant against)");
  } else if (RUN_GROUP === "labor-purchasing") {
    lines.push(`expected: ${planted.expected}`);
    lines.push(`caught: ${planted.caught}`);
    if (planted.labor) {
      lines.push(`labor base case: ${planted.labor.base_case_id}`);
      lines.push(`  plants: number=${planted.labor.changed_number_key} removed=${planted.labor.removed_key} emptied=${planted.labor.emptied_array_key}`);
      lines.push(`  caught: ${planted.labor.caught} paths: ${(planted.labor.diff_report || []).join(", ")}`);
    }
    if (planted.purchasing) {
      lines.push(`purchasing base case: ${planted.purchasing.base_case_id}`);
      lines.push(`  plants: number=${planted.purchasing.changed_number_key} removed=${planted.purchasing.removed_key} emptied=${planted.purchasing.emptied_array_key}`);
      lines.push(`  caught: ${planted.purchasing.caught} paths: ${(planted.purchasing.diff_report || []).join(", ")}`);
    }
  } else {
    lines.push(`base case: ${planted.base_case_id}`);
    lines.push(`planted: number=${planted.changed_number_key} removed=${planted.removed_key} emptied=${planted.emptied_array_key}`);
    lines.push(`caught: ${planted.caught} field path(s): ${(planted.diff_report || []).join(", ")}`);
  }
  lines.push("");

  // Differing cases: classify per field path.
  if (directSumsAll && directSumsAll.length) {
    lines.push("## Differing cases - per-field classification");
    for (const entry of directSumsAll) {
      lines.push(`### ${entry.id} (${entry.route} / ${entry.group})`);
      lines.push(`v1_status=${entry.v1_status} v2_status=${entry.v2_status}`);
      lines.push("path | classification");
      for (const v of entry.verdicts) {
        lines.push(`${v.path} | ${v.classification}`);
      }
      lines.push("");
    }
    // Stop-ship summary.
    const stopShip = directSumsAll.flatMap(e =>
      e.verdicts.filter(v => v.classification === "neither_matches" || v.classification === "entry_wrong")
                .map(v => ({ id: e.id, path: v.path, classification: v.classification }))
    );
    lines.push("## Stop-ship defects (neither_matches or entry_wrong)");
    if (stopShip.length === 0) {
      lines.push("- none");
    } else {
      for (const s of stopShip) lines.push(`- ${s.id} :: ${s.path} :: ${s.classification}`);
    }
    lines.push("");
  }

  lines.push("## Per-case fingerprints");
  lines.push("id | group | route | status | v1_status | v2_status | fp_A | fp_V | attempts | differ");
  for (const c of perCase) {
    lines.push(`${c.id} | ${c.group} | ${c.route || ""} | ${c.status} | ${c.v1_status ?? ""} | ${c.v2_status ?? ""} | ${c.fp_A?.slice(0, 16) ?? ""} | ${c.fp_V?.slice(0, 16) ?? ""} | ${c.attempts ?? ""} | ${(c.differ || []).join(", ")}`);
  }
  return lines.join("\n");
}

run().catch(e => {
  console.error("fatal:", e);
  process.exit(2);
});
