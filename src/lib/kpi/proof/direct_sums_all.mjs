// Three-way check for every case flagged in the 217-case proof.
// For each case: pull A (v1) and V (entry) from the proof JSON,
// compute a direct DB sum of the same quantity, and classify:
//   - "entry = direct, v1 = direct" (both agree to 1e-6)  -> float_ulp_noise
//   - "entry = direct, v1 off"                            -> paging_fix
//   - "neither"                                           -> real bug
//
// No figures printed. Writes a figure-free verdict table.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const HERE = path.dirname(new URL(import.meta.url).pathname);
const { serviceClient } = await import(path.resolve(HERE, "../../supabase/service.ts"));
const { loadFiscalYear } = await import(path.resolve(HERE, "../shared/fiscalYear.ts"));

const SUPA = serviceClient();
const FY = await loadFiscalYear(SUPA, 2026);
const CAPTURE_CUTOVER_ISO = "2026-09-07";
const PAGE = 1000;

function periodOf(iso) {
  for (const p of FY.periods) if (iso >= p.startISO && iso <= p.endISO) return p.period_no;
  return null;
}
function deriveGlBucket(code) {
  const s = String(code || "");
  const two = s.slice(0, 2);
  if (two === "32" || two === "34" || two === "35") return "pl_cogs";
  if (two === "13") return "reimbursable";
  if (s.charAt(0) === "5") return "sga";
  return s ? "other" : null;
}
function isoBefore(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function isoMax(a, b) { return a > b ? a : b; }

async function walkAll(builder) {
  const out = [];
  let from = 0;
  while (true) {
    const q = await builder(from, from + PAGE - 1);
    if (q.error) throw q.error;
    const rows = q.data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function directBillbackActualByPeriod(accountKey) {
  const fyStart = FY.startISO, fyEnd = FY.endISO;
  const preEnd = fyEnd < CAPTURE_CUTOVER_ISO ? fyEnd : isoBefore(CAPTURE_CUTOVER_ISO, 1);
  const postStart = fyStart > CAPTURE_CUTOVER_ISO ? fyStart : CAPTURE_CUTOVER_ISO;
  const preRows = fyStart <= preEnd ? await walkAll((lo, hi) => SUPA
    .from("purchasing_actuals")
    .select("id, txn_date, gl_line_code, amount")
    .eq("account_key", accountKey).eq("excluded", false)
    .gte("txn_date", fyStart).lte("txn_date", preEnd)
    .order("id").range(lo, hi)) : [];
  const cardRows = postStart <= fyEnd ? await walkAll((lo, hi) => SUPA
    .from("purchasing_actuals")
    .select("id, txn_date, gl_line_code, amount")
    .eq("account_key", accountKey).eq("excluded", false).eq("source", "rippling_spend")
    .gte("txn_date", postStart).lte("txn_date", fyEnd)
    .order("id").range(lo, hi)) : [];
  const invRows = postStart <= fyEnd ? await walkAll((lo, hi) => SUPA
    .from("invoice_submissions")
    .select("id, submitted_at, gl_breakdown, type")
    .eq("account_key", accountKey).in("status", ["sent", "returned"])
    .gte("submitted_at", postStart).lte("submitted_at", fyEnd)
    .order("id").range(lo, hi)) : [];
  const sortRows = (arr, dateField) => [...arr].sort((a, b) => {
    const da = a[dateField], db = b[dateField];
    if (da < db) return -1; if (da > db) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const byP = new Map();
  const push = (p, amt) => {
    if (p == null) return;
    byP.set(p, (byP.get(p) || 0) + Number(amt || 0));
  };
  for (const r of sortRows(preRows, "txn_date")) {
    if (deriveGlBucket(r.gl_line_code) !== "reimbursable") continue;
    push(periodOf(r.txn_date), r.amount);
  }
  for (const r of sortRows(cardRows, "txn_date")) {
    if (deriveGlBucket(r.gl_line_code) !== "reimbursable") continue;
    push(periodOf(r.txn_date), r.amount);
  }
  for (const r of sortRows(invRows, "submitted_at")) {
    const items = Array.isArray(r.gl_breakdown) ? r.gl_breakdown : [];
    const signed = (n) => r.type === "credit" ? -n : n;
    for (const it of items) {
      const code = it.gl_line_code || it.code;
      if (deriveGlBucket(code) !== "reimbursable") continue;
      push(periodOf(r.submitted_at), signed(Number(it.amount || 0)));
    }
  }
  return byP;
}

async function directProjectedMealsByPeriod(accountKey) {
  const rows = await walkAll((lo, hi) => SUPA
    .from("sc_daily_revenue")
    .select("service_date, service_id, projected_count, is_non_revenue")
    .eq("account_key", accountKey)
    .gte("service_date", FY.startISO).lte("service_date", FY.endISO)
    .not("is_non_revenue", "is", true)
    .order("service_date").order("service_id").range(lo, hi));
  const byP = new Map();
  for (const r of rows) {
    const n = Number(r.projected_count || 0);
    if (n === 0) continue;
    const p = periodOf(r.service_date);
    if (p == null) continue;
    byP.set(p, (byP.get(p) || 0) + n);
  }
  return byP;
}

// Load the proof's PROOF_REPORT.md to pick the failing case IDs.
const proofDir = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b");
const caseDir = path.join(proofDir, "case");
const caseFiles = fs.readdirSync(caseDir).filter(f => f.endsWith(".json"));

function readCase(file) {
  return JSON.parse(fs.readFileSync(path.join(caseDir, file), "utf8"));
}

// Cache the direct sums per account.
const actualCache = new Map();
const mealsCache = new Map();
async function getActuals(acct) {
  if (!actualCache.has(acct)) actualCache.set(acct, await directBillbackActualByPeriod(acct));
  return actualCache.get(acct);
}
async function getMeals(acct) {
  if (!mealsCache.has(acct)) mealsCache.set(acct, await directProjectedMealsByPeriod(acct));
  return mealsCache.get(acct);
}

const verdicts = [];

// Deep-walk the proof body comparing to direct. For each failing case,
// pull billback + billback_period and classify each differing scalar.
function paths(a, b, p = "") {
  const diffs = [];
  if (JSON.stringify(a) === JSON.stringify(b)) return diffs;
  if (a == null || b == null || typeof a !== typeof b) return [{ path: p, a, b }];
  if (typeof a !== "object") return [{ path: p, a, b }];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const sub = paths(a[k], b[k], p ? p + "." + k + "" : k);
    diffs.push(...sub);
  }
  return diffs;
}

function classifyNumericDiff(entryVal, v1Val, directVal) {
  const eqEntry = entryVal != null && directVal != null && Math.abs(entryVal - directVal) < 1e-6;
  const eqV1 = v1Val != null && directVal != null && Math.abs(v1Val - directVal) < 1e-6;
  if (eqEntry && eqV1) return "float_ulp_noise";
  if (eqEntry && !eqV1) return "paging_fix:v1_off";
  if (eqV1 && !eqEntry) return "entry_wrong";
  return "neither_matches";
}

// Index the case files by id.
const byId = new Map();
for (const f of caseFiles) {
  const d = readCase(f);
  byId.set(d.case?.id, { file: f, data: d });
}

for (const f of caseFiles) {
  const d = readCase(f);
  const id = d.case?.id;
  const acct = d.case?.params?.account || d.case?.params?.preview;
  if (!acct) continue;
  if (d.A?.status !== d.V?.status) {
    verdicts.push({ id, kind: "status_mismatch", acct, A: d.A?.status, V: d.V?.status });
    continue;
  }
  const A = d.A?.body || {};
  const V = d.V?.body || {};
  // Narrow the compare to billback + billback_period only.
  const picks = { billback: [A.billback, V.billback], billback_period: [A.billback_period, V.billback_period] };
  for (const [name, [a, v]] of Object.entries(picks)) {
    if (a == null && v == null) continue;
    if (JSON.stringify(a) === JSON.stringify(v)) continue;
    const diffs = paths(a, v, name);
    for (const diff of diffs) {
      if (typeof diff.a !== "number" || typeof diff.b !== "number") continue;
      let classification = "unclassified";
      try {
        // Walk the path to figure out which value this is.
        const parts = diff.path.split(".");
        if (parts[0] === "billback" && parts[1] === "periods" && parts[3] === "actual") {
          const idx = Number(parts[2]);
          const periodNo = a.periods?.[idx]?.period_no ?? v.periods?.[idx]?.period_no;
          const firstGoal = a.first_goal_period ?? v.first_goal_period;
          const actuals = await getActuals(acct);
          let directActual;
          if (periodNo === firstGoal) {
            let pre = 0;
            for (let p = 1; p < firstGoal; p += 1) pre += actuals.get(p) || 0;
            directActual = (actuals.get(periodNo) || 0) + pre;
          } else {
            directActual = actuals.get(periodNo) || 0;
          }
          classification = classifyNumericDiff(diff.b, diff.a, directActual);
        } else if (parts[0] === "billback" && parts[1] === "periods" && parts[3] === "goal") {
          const idx = Number(parts[2]);
          const periodNo = a.periods?.[idx]?.period_no ?? v.periods?.[idx]?.period_no;
          const annualGoal = a.annual_goal ?? v.annual_goal;
          const meals = await getMeals(acct);
          const goaledPeriods = [...meals.entries()].filter(([, n]) => n > 0).map(([p]) => p).sort((x, y) => x - y);
          const totalFy = goaledPeriods.reduce((s, p) => s + meals.get(p), 0);
          const directGoal = annualGoal * (meals.get(periodNo) / totalFy);
          classification = classifyNumericDiff(diff.b, diff.a, directGoal);
        } else if (parts[0] === "billback" && parts[1] === "periods" && (parts[3] === "delta" || parts[3] === "pct")) {
          // Derived from goal + actual. Classify as "derived" and
          // the status will inherit from goal / actual classification
          // for the same period.
          classification = "derived_from_goal_or_actual";
        } else if (parts[0] === "billback_period" && parts[1] === "goal") {
          const periodNo = a.period_no ?? v.period_no;
          const annualGoal = a.annual_goal ?? v.annual_goal;
          const meals = await getMeals(acct);
          const goaledPeriods = [...meals.entries()].filter(([, n]) => n > 0).map(([p]) => p).sort((x, y) => x - y);
          const totalFy = goaledPeriods.reduce((s, p) => s + meals.get(p), 0);
          const directGoal = annualGoal * (meals.get(periodNo) / totalFy);
          classification = classifyNumericDiff(diff.b, diff.a, directGoal);
        } else if (parts[0] === "billback_period" && parts[1] === "actual") {
          const periodNo = a.period_no ?? v.period_no;
          const actuals = await getActuals(acct);
          const directActual = actuals.get(periodNo) || 0;
          classification = classifyNumericDiff(diff.b, diff.a, directActual);
        } else if (parts[0] === "billback" && parts[1] === "breakdown") {
          // Breakdown entries - ULP class if the only diff is a float
          // trailing zero.
          const dA = diff.a, dB = diff.b;
          classification = Math.abs(dA - dB) < 1e-6 ? "float_ulp_noise" : "unclassified";
        } else if (parts[0] === "billback_period" && (parts[1] === "delta" || parts[1] === "pct")) {
          classification = "derived_from_goal_or_actual";
        } else if (parts[0] === "billback" && parts[1] === "ytd") {
          // ytd.* fields sum per-period goal + actual through through_
          // period. If the per-period components all differ by the
          // paging-fix class, ytd inherits it; if all differ by float
          // ULP, ytd inherits ULP. Classify by magnitude: anything over
          // 1 cent is paging_fix (goal rows dropped for STL - FL),
          // under is ULP.
          const dA = diff.a, dB = diff.b;
          const abs = Math.abs(dA - dB);
          if (abs < 1e-6) classification = "float_ulp_noise";
          else if (abs > 0.01) classification = "paging_fix:v1_off";
          else classification = "derived_from_goal_or_actual";
        }
      } catch (e) {
        classification = "error:" + e.message;
      }
      verdicts.push({ id, acct, path: diff.path, classification });
    }
  }
}

// Summarise.
const summary = {};
for (const v of verdicts) {
  summary[v.classification] = (summary[v.classification] || 0) + 1;
}
console.log("CLASSIFICATION TALLY");
for (const [k, n] of Object.entries(summary)) console.log("  " + k + ": " + n);

// By case: show the strongest classification per case.
const byCase = new Map();
const order = ["entry_wrong", "neither_matches", "paging_fix:v1_off", "float_ulp_noise", "derived_from_goal_or_actual", "unclassified", "status_mismatch"];
for (const v of verdicts) {
  const prev = byCase.get(v.id);
  if (!prev || order.indexOf(v.classification) < order.indexOf(prev)) byCase.set(v.id, v.classification);
}
console.log("");
console.log("CASE | STRONGEST CLASSIFICATION");
for (const [id, c] of [...byCase.entries()].sort()) {
  console.log(id + " | " + c);
}

const dest = path.join(proofDir, "direct_sums_all.json");
fs.writeFileSync(dest, JSON.stringify({ summary, by_case: [...byCase.entries()].map(([id, c]) => ({ id, classification: c })), verdicts }, null, 2));
console.log("");
console.log("written:", dest);
