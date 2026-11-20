// Three-way check for the 23 cases flagged in the 217-case proof.
// Computes a DIRECT sum from the database using the same filter
// billback uses, with no paging (no .range()), no .order() needed on
// the reader side because we materialise everything into an array and
// sum. Then compares to v1's answer (from the proof JSON) and the
// entry's answer (from the same proof JSON). No figures printed:
// only "v1 = direct", "entry = direct", or "neither"; percent diff;
// the kind (float_ulp_noise | whole_cent).

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

const MS_PER_DAY = 86400000;
const CAPTURE_CUTOVER_ISO = "2026-09-07";
const PAGE = 1000;

function periodOf(iso) {
  for (const p of FY.periods) {
    if (iso >= p.startISO && iso <= p.endISO) return p.period_no;
  }
  return null;
}

function deriveGlBucket(code) {
  const s = String(code || "");
  if (!s) return null;
  const two = s.slice(0, 2);
  if (two === "32" || two === "34" || two === "35") return "pl_cogs";
  if (two === "13") return "reimbursable";
  if (s.charAt(0) === "5") return "sga";
  return "other";
}

function isoBefore(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function isoMax(a, b) { return a > b ? a : b; }

async function walkAll(builder) {
  // Straight paged walk with page size 1000; the uniqueness of the
  // sort does not matter because we gather every row and sort it in
  // JS by its uuid id before summing - so the order of summation is
  // reproducible across runs of this script.
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
  const fyStart = FY.startISO;
  const fyEnd = FY.endISO;
  const preEnd = fyEnd < CAPTURE_CUTOVER_ISO ? fyEnd : isoBefore(CAPTURE_CUTOVER_ISO, 1);
  const postStart = fyStart > CAPTURE_CUTOVER_ISO ? fyStart : CAPTURE_CUTOVER_ISO;

  const preRows = fyStart <= preEnd ? await walkAll((lo, hi) => SUPA
    .from("purchasing_actuals")
    .select("id, txn_date, gl_line_code, amount")
    .eq("account_key", accountKey)
    .eq("excluded", false)
    .gte("txn_date", fyStart)
    .lte("txn_date", preEnd)
    .order("id", { ascending: true })
    .range(lo, hi)) : [];

  const cardRows = postStart <= fyEnd ? await walkAll((lo, hi) => SUPA
    .from("purchasing_actuals")
    .select("id, txn_date, gl_line_code, amount")
    .eq("account_key", accountKey)
    .eq("excluded", false)
    .eq("source", "rippling_spend")
    .gte("txn_date", postStart)
    .lte("txn_date", fyEnd)
    .order("id", { ascending: true })
    .range(lo, hi)) : [];

  const invRows = postStart <= fyEnd ? await walkAll((lo, hi) => SUPA
    .from("invoice_submissions")
    .select("id, submitted_at, gl_breakdown, type")
    .eq("account_key", accountKey)
    .in("status", ["sent", "returned"])
    .gte("submitted_at", postStart)
    .lte("submitted_at", fyEnd)
    .order("id", { ascending: true })
    .range(lo, hi)) : [];

  // Sum reimbursable amounts bucketed by periodOf(date).
  // Sort each lane by (date, id) so the sum order is deterministic.
  const sortRows = (arr, dateField) => [...arr].sort((a, b) => {
    const da = a[dateField], db = b[dateField];
    if (da < db) return -1;
    if (da > db) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const byP = new Map();
  const push = (p, amt) => {
    if (p == null) return;
    if (!byP.has(p)) byP.set(p, 0);
    byP.set(p, byP.get(p) + Number(amt || 0));
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

async function directBillbackActualByPeriodFoldPreseason(accountKey, firstGoalPeriod) {
  const byP = await directBillbackActualByPeriod(accountKey);
  if (!firstGoalPeriod || firstGoalPeriod <= 1) return byP;
  let pre = 0;
  for (let p = 1; p < firstGoalPeriod; p += 1) pre += byP.get(p) || 0;
  const foldedP = byP.get(firstGoalPeriod) || 0;
  const out = new Map(byP);
  for (let p = 1; p < firstGoalPeriod; p += 1) out.delete(p);
  out.set(firstGoalPeriod, foldedP + pre);
  return out;
}

async function directProjectedMealsByPeriod(accountKey) {
  // Pull every sc_daily_revenue row for the account in FY2026, with
  // paging. Sort by (service_date, service_id) for deterministic sum
  // order. is_non_revenue excluded, projected_count > 0 only.
  const rows = await walkAll((lo, hi) => SUPA
    .from("sc_daily_revenue")
    .select("service_date, service_id, projected_count, is_non_revenue")
    .eq("account_key", accountKey)
    .gte("service_date", FY.startISO)
    .lte("service_date", FY.endISO)
    .not("is_non_revenue", "is", true)
    .order("service_date")
    .order("service_id")
    .range(lo, hi));
  const byP = new Map();
  let totalCount = 0;
  for (const r of rows) {
    const n = Number(r.projected_count || 0);
    if (n === 0) continue;
    const p = periodOf(r.service_date);
    if (p == null) continue;
    byP.set(p, (byP.get(p) || 0) + n);
    totalCount += n;
  }
  return { byP, totalCount, rowCount: rows.length };
}

function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  const denom = Math.abs(a) > Math.abs(b) ? a : b;
  if (denom === 0) return Infinity;
  return ((a - b) / denom) * 100;
}

function classify(d) {
  if (Math.abs(d) < 1e-6) return "float_ulp_noise";
  if (Math.abs(d) < 0.005) return "sub_cent";
  return "whole_cent";
}

// Pull cases from the proof JSON.
const proofDir = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b/case");
function caseByPrefix(prefix) {
  const files = fs.readdirSync(proofDir).filter(f => f.startsWith(prefix));
  if (files.length !== 1) throw new Error("ambiguous prefix " + prefix + ": " + files.join(","));
  return JSON.parse(fs.readFileSync(path.join(proofDir, files[0]), "utf8"));
}

const out = { checks: [] };

// --- CIN - OH, billback.periods[0].actual (= P4 after preseason fold) ---
{
  const d = caseByPrefix("017-g1-CIN - OH-currentYear-saloff");
  const A = d.A.body.billback;
  const V = d.V.body.billback;
  const idx = 0;
  const v1Actual = A.periods[idx].actual;
  const entryActual = V.periods[idx].actual;
  const periodNo = A.periods[idx].period_no;
  const direct = await directBillbackActualByPeriodFoldPreseason("CIN - OH", A.first_goal_period);
  const directActual = direct.get(periodNo) || 0;
  const v1Pct = pctDiff(v1Actual, directActual);
  const entryPct = pctDiff(entryActual, directActual);
  out.checks.push({
    label: "CIN - OH, billback.periods[0].actual (period_no=" + periodNo + ", includes preseason fold P1..P" + (A.first_goal_period - 1) + ")",
    v1_vs_direct_pct: v1Pct,
    entry_vs_direct_pct: entryPct,
    kind: "actual",
    v1_eq_direct: Math.abs(v1Actual - directActual) < 1e-6,
    entry_eq_direct: Math.abs(entryActual - directActual) < 1e-6,
    diff_v1_minus_entry: v1Actual - entryActual,
    classification: classify(v1Actual - entryActual),
  });
}

// --- STL - MO, billback.periods[5].actual (= P9) ---
{
  const d = caseByPrefix("029-g1-STL - MO-currentYear-saloff");
  const A = d.A.body.billback;
  const V = d.V.body.billback;
  const idx = 5;
  const v1Actual = A.periods[idx].actual;
  const entryActual = V.periods[idx].actual;
  const periodNo = A.periods[idx].period_no;
  const direct = await directBillbackActualByPeriodFoldPreseason("STL - MO", A.first_goal_period);
  const directActual = direct.get(periodNo) || 0;
  const v1Pct = pctDiff(v1Actual, directActual);
  const entryPct = pctDiff(entryActual, directActual);
  out.checks.push({
    label: "STL - MO, billback.periods[5].actual (period_no=" + periodNo + ")",
    v1_vs_direct_pct: v1Pct,
    entry_vs_direct_pct: entryPct,
    kind: "actual",
    v1_eq_direct: Math.abs(v1Actual - directActual) < 1e-6,
    entry_eq_direct: Math.abs(entryActual - directActual) < 1e-6,
    diff_v1_minus_entry: v1Actual - entryActual,
    classification: classify(v1Actual - entryActual),
  });
}

// --- STL - FL, meal projection total for the year (sum_fy_meals) ---
{
  const d = caseByPrefix("022-g1-STL - FL-currentYear-salon");
  const A = d.A.body.billback;
  const V = d.V.body.billback;
  // Reconstruct sum_fy_meals from (goal * total_fy_meals / period_meals)
  // isn't possible; instead compare the total via annual_goal and
  // sum of period_goals (which equals annual_goal by construction).
  // The meal projection total itself isn't in the payload, but the
  // per-period goals divide annual_goal by (period_meals /
  // sum_fy_meals). The sum of periods[].goal in a settled, goaled
  // year equals annual_goal. Any diff between the sum and annual_goal
  // signals a lost / added row in the meal projection reader.
  const annualGoal = A.annual_goal;
  const sumA = A.periods.filter(x => x.goal != null).reduce((s, x) => s + x.goal, 0);
  const sumV = V.periods.filter(x => x.goal != null).reduce((s, x) => s + x.goal, 0);

  // Direct meal projection for STL - FL
  const direct = await directProjectedMealsByPeriod("STL - FL");
  const goaledPeriods = [...direct.byP.entries()].filter(([, n]) => n > 0).map(([p]) => p).sort((a, b) => a - b);
  const totalFyMeals = goaledPeriods.reduce((s, p) => s + direct.byP.get(p), 0);
  const directPeriodGoals = goaledPeriods.map(p => annualGoal * (direct.byP.get(p) / totalFyMeals));
  const sumDirect = directPeriodGoals.reduce((s, x) => s + x, 0);

  out.checks.push({
    label: "STL - FL, meal projection total (annual_goal = sum_of_period_goals)",
    kind: "goal_total",
    annual_goal_in_payload: annualGoal,
    sum_v1_period_goals: sumA,
    sum_entry_period_goals: sumV,
    sum_direct_period_goals: sumDirect,
    v1_vs_direct_pct: pctDiff(sumA, sumDirect),
    entry_vs_direct_pct: pctDiff(sumV, sumDirect),
    v1_vs_annual_pct: pctDiff(sumA, annualGoal),
    entry_vs_annual_pct: pctDiff(sumV, annualGoal),
    direct_meal_row_count: direct.rowCount,
    direct_total_meals: totalFyMeals,
    first_goal_period: A.first_goal_period,
  });

  // Also compare per-period goal.
  for (let i = 0; i < goaledPeriods.length; i += 1) {
    const p = goaledPeriods[i];
    const v1Goal = A.periods.find(x => x.period_no === p)?.goal ?? null;
    const entryGoal = V.periods.find(x => x.period_no === p)?.goal ?? null;
    const directGoal = directPeriodGoals[i];
    out.checks.push({
      label: "STL - FL, billback.periods[period_no=" + p + "].goal",
      kind: "goal",
      v1: v1Goal,
      entry: entryGoal,
      direct: directGoal,
      v1_vs_direct_pct: pctDiff(v1Goal, directGoal),
      entry_vs_direct_pct: pctDiff(entryGoal, directGoal),
      v1_eq_direct: v1Goal != null && Math.abs(v1Goal - directGoal) < 1e-6,
      entry_eq_direct: entryGoal != null && Math.abs(entryGoal - directGoal) < 1e-6,
    });
  }
}

// Strip figures; keep only the relative results.
const stripped = out.checks.map(c => {
  const copy = { ...c };
  delete copy.v1; delete copy.entry; delete copy.direct;
  delete copy.annual_goal_in_payload; delete copy.sum_v1_period_goals;
  delete copy.sum_entry_period_goals; delete copy.sum_direct_period_goals;
  delete copy.direct_total_meals; delete copy.diff_v1_minus_entry;
  delete copy.direct_meal_row_count;
  return copy;
});
console.log(JSON.stringify(stripped, null, 2));

// Also print a figure-free one-line verdict per check.
for (const c of out.checks) {
  const v1Pct = c.v1_vs_direct_pct ?? 0;
  const enPct = c.entry_vs_direct_pct ?? 0;
  const verdict = (() => {
    const v1Ok = Math.abs(v1Pct) < 1e-6;
    const enOk = Math.abs(enPct) < 1e-6;
    if (v1Ok && enOk) return "v1 = direct, entry = direct";
    if (v1Ok) return "v1 = direct, entry off by " + enPct.toFixed(6) + "%";
    if (enOk) return "entry = direct, v1 off by " + v1Pct.toFixed(6) + "%";
    return "neither; v1 off " + v1Pct.toFixed(6) + "%, entry off " + enPct.toFixed(6) + "%";
  })();
  console.log(c.label + ": " + verdict);
}

const destDir = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b");
fs.writeFileSync(path.join(destDir, "direct_sums.json"), JSON.stringify(stripped, null, 2));
console.log("");
console.log("written:", path.join(destDir, "direct_sums.json"));
