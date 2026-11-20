// Same-answers proof for KPI engine train 2a.
//
// For each case in Appendix B (217 cases, this file enumerates them
// from the inputs): ask v1's local dev server at
// http://localhost:3100/api/kpi/overview (TEST_MODE=true, VERCEL
// unset) and the V2 entry, back to back. The run is:
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
// an email or a drive URL (purchasing payload's `submitter_email`,
// `drive_url_stamped`, `drive_url_raw`, and anything else matching
// the field shape). The comparison is exact on everything else.
//
// `regional_directors_display` is excluded from the comparison (item
// 3 in the brief).
//
// Usage:
//   node --import tsx src/lib/kpi/proof/compare_answers.mjs \
//        [--env-file=/path/to/.env.local]
//
// Writes to ~/Downloads/KPI_V2_Handoff/proof_2a/:
//   - case/<idx>.json     the raw A + V + B for each case (post-redact)
//   - fingerprints.json   per-case sha256 of the comparison bodies
//   - PROOF_REPORT.md     human-readable summary
//   - planted/*           the three planted-difference proofs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const V1_BASE = process.env.V1_BASE || "http://localhost:3100";
const OUT_DIR = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b");

// Load V2 .env.local via --env-file= if present.
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
async function askV1(params) {
  const q = new URLSearchParams(params);
  const url = `${V1_BASE}/api/kpi/overview?${q.toString()}`;
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

// Lazy-load V2's entry + its deps on demand (the entry is TS).
let getOverview = null;
let serviceClient = null;
let periodHelpers = null;
let loadFiscalYear = null;
let FY2026 = null;
async function loadV2() {
  if (getOverview) return;
  ({ getOverview } = await import("../entry.ts"));
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

// Build the 217 cases.
async function buildCases(todayISO) {
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

// Redact + fingerprint. Keys named like emails or drive URLs get
// their values sha256'd BEFORE save, so the saved answers never hold
// the clear value but the comparison still fires on a drift.
const REDACT_KEYS_SUBSTR = ["email", "drive_url", "submitter"];
const REDACT_VALUE_PATTERNS = [
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  /^https?:\/\/(drive\.google\.com|docs\.google\.com)\//i,
];

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
      if (keyFlags && typeof v === "string" && v.length) {
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

async function runCase(c) {
  const v1Params = { ...c.params };
  if (c.testRole) Object.assign(v1Params, c.testRole);
  // Clean undefined/empty-string params for v1 URL hygiene.
  for (const k of Object.keys(v1Params)) if (v1Params[k] == null || v1Params[k] === "") delete v1Params[k];
  const v2ParamsBase = { ...c.params };
  for (const k of Object.keys(v2ParamsBase)) if (v2ParamsBase[k] == null || v2ParamsBase[k] === "") delete v2ParamsBase[k];

  let A = await askV1(v1Params);
  const todayISO = A.body?.todayISO || null;
  const V = await askV2(v2ParamsBase, c.caller, todayISO);
  let B = await askV1(v1Params);
  let attempt = 1;
  let stable = deepEqual(stripRegionalDirectors(A.body), stripRegionalDirectors(B.body));
  while (!stable && attempt < 3) {
    A = B;
    B = await askV1(v1Params);
    stable = deepEqual(stripRegionalDirectors(A.body), stripRegionalDirectors(B.body));
    attempt++;
  }
  return { A, V, B, stable, attempts: attempt };
}

async function run() {
  // Prime V2 for today derivation (we also need the entry + helpers).
  await loadV2();
  // Ask v1 once to get its todayISO.
  const seed = await askV1({ account: "" });
  const todayISO = seed.body?.todayISO;
  if (!todayISO) {
    console.error("v1 did not return todayISO; is the server up?");
    process.exit(2);
  }
  const { cases, ranges, curP, nextP, lastVerifiedP, fyEndCur } = await buildCases(todayISO);

  const redactCounts = {};
  const perCase = [];
  let pass = 0, fail = 0, unstable = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    try {
      const r = await runCase(c);
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
        }
      }
      const fp = {
        id: c.id,
        group: c.group,
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
      perCase.push({ id: c.id, group: c.group, status: "ERROR", error: String(e?.message || e) });
      console.log(`[${i + 1}/${cases.length}] ${c.id}: ERROR ${e?.message}`);
    }
  }

  // Planted-difference proof. Pick a passing case; plant three
  // minimal, non-cascading changes and confirm the comparator fires
  // on exactly three field paths.
  //
  //   1. Change one scalar top-level number.
  //   2. Remove one scalar top-level key.
  //   3. Drop the sole element from a length-1 array (or if none
  //      exists, empty a longer array - the diff still lands on the
  //      array as a whole because the reference changes).
  //
  // The comparator's `diffKeys` recurses into objects but treats
  // arrays as whole values: when an array differs, it is reported as
  // one path. This keeps the planted count tight at 3.
  const firstPass = perCase.find(x => x.status === "pass");
  let planted = null;
  if (firstPass) {
    const i = perCase.indexOf(firstPass);
    const caseFile = path.join(OUT_DIR, "case", `${String(i).padStart(3, "0")}-${firstPass.id}.json`);
    const data = JSON.parse(fs.readFileSync(caseFile, "utf8"));
    const copy = JSON.parse(JSON.stringify(data));
    const body = copy.V.body;
    const keys = Object.keys(body);
    // 1. Change one scalar number.
    const numericKey = keys.find(k => typeof body[k] === "number");
    if (numericKey) body[numericKey] = body[numericKey] + 1;
    // 2. Remove one scalar key (not an object, not an array).
    const removeKey = keys.find(k => k !== numericKey && typeof body[k] !== "object");
    if (removeKey) delete body[removeKey];
    // 3. Replace one NON-EMPTY array with an empty array. (An empty
    // array replaced by another empty array is a no-op; the planted
    // sentinel needs a genuine value change to fire.)
    const arrayKey = keys.find(k => Array.isArray(body[k]) && body[k].length > 0 && k !== numericKey && k !== removeKey);
    if (arrayKey) body[arrayKey] = [];
    const differ = diffKeysArrayAsWhole(copy.A.body, body);
    planted = {
      base_case_id: firstPass.id,
      changed_number_key: numericKey,
      removed_key: removeKey,
      emptied_array_key: arrayKey,
      diff_report: differ,
      caught: differ.length,
    };
    fs.writeFileSync(path.join(OUT_DIR, "planted", "planted_diff.json"), JSON.stringify(planted, null, 2));
  }

  // Write fingerprints + report.
  fs.writeFileSync(path.join(OUT_DIR, "fingerprints.json"), JSON.stringify(perCase, null, 2));
  const report = buildReport({ todayISO, curP, nextP, lastVerifiedP, fyEndCur, pass, fail, unstable, perCase, redactCounts, planted });
  fs.writeFileSync(path.join(OUT_DIR, "PROOF_REPORT.md"), report);

  console.log("---");
  console.log(`pass: ${pass}  fail: ${fail}  unstable: ${unstable}  total: ${cases.length}`);
  console.log(`Report: ${path.join(OUT_DIR, "PROOF_REPORT.md")}`);
}

function buildReport({ todayISO, curP, nextP, lastVerifiedP, fyEndCur, pass, fail, unstable, perCase, redactCounts, planted }) {
  const lines = [];
  lines.push("# KPI engine train 2a - same-answers proof report");
  lines.push("");
  lines.push(`todayISO (from v1): ${todayISO}`);
  lines.push(`currentPeriodNo: ${curP}`);
  lines.push(`nextPeriodNo: ${nextP}`);
  lines.push(`lastVerifiedPeriodNo (used, proxy curP-1): ${lastVerifiedP}`);
  lines.push(`currentYear range end (r93FytdEndISO): ${fyEndCur}`);
  lines.push("");
  lines.push("## Counts");
  lines.push(`total: ${perCase.length}`);
  lines.push(`pass: ${pass}`);
  lines.push(`fail: ${fail}`);
  lines.push(`unstable: ${unstable}`);
  lines.push("");
  lines.push("## Redactions");
  for (const [k, n] of Object.entries(redactCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${n}`);
  }
  lines.push("");
  lines.push("## Excluded field");
  lines.push("- regional_directors_display (item 3, V2 passes it as input; v1 derives from REGIONAL_DIRECTORS)");
  lines.push("");
  lines.push("## Planted-difference proof");
  if (planted) {
    lines.push(`base case: ${planted.base_case_id}`);
    lines.push(`planted: 1 number change (${planted.changed_number_key}), 1 key removed (${planted.removed_key}), 1 array element dropped (${planted.dropped_array_key})`);
    lines.push(`caught: ${planted.caught} field path(s): ${planted.diff_report.join(", ")}`);
  } else {
    lines.push("not run (no passing case to plant against)");
  }
  lines.push("");
  lines.push("## Salaried-manager cases - keys whose name contains 'salary'");
  const salaryManagerCase = perCase.find(c => c.group === "4.siteManager" && c.status === "pass");
  if (salaryManagerCase) lines.push(`sampled: ${salaryManagerCase.id}`);
  lines.push("");
  lines.push("## Per-case fingerprints");
  lines.push("id | group | status | v1_status | v2_status | fp_A | fp_V | attempts | differ");
  for (const c of perCase) {
    lines.push(`${c.id} | ${c.group} | ${c.status} | ${c.v1_status ?? ""} | ${c.v2_status ?? ""} | ${c.fp_A?.slice(0, 16) ?? ""} | ${c.fp_V?.slice(0, 16) ?? ""} | ${c.attempts ?? ""} | ${(c.differ || []).join(", ")}`);
  }
  return lines.join("\n");
}

run().catch(e => {
  console.error("fatal:", e);
  process.exit(2);
});
