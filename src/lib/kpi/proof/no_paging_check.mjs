// No-paging three-way check for the 8 cases the paging-explanation does
// not cover: CIN - OH and STL - MO billback actuals, and STL - FL meal
// projection (included to verify the "entry = direct" expectation).
//
// For CIN - OH and STL - MO every read fits in one page for fiscal 2026
// (purchasing_actuals pre-cutover: CIN - OH 513 rows, STL - MO 938;
// sc_daily_revenue ~600 each; invoice_submissions post-cutover tiny).
// So paging cannot change the sum. We bypass paging entirely: pull the
// whole result in one .range(0, 9999) call and assert rows.length < 1000
// so we know we had the complete set.
//
// Direct is the CANONICAL sum: amounts in integer cents, order-invariant.
// Then compare to v1's JSON answer and entry's JSON answer:
//   - "entry = direct" means entry's JSON number equals direct exactly.
//   - "v1 = direct"    means v1's JSON number equals direct exactly.
//   - "neither"        means neither is byte-exact; percent-diffs reported.
//
// Pure read; no mutation, no writes.

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
const ASSERT_CAP = 9999; // one call fetches up to 10k; assert < 1000 so we know it fit

function periodOf(iso) {
  for (const p of FY.periods) if (iso >= p.startISO && iso <= p.endISO) return p.period_no;
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
async function oneShot(builder, label) {
  const q = await builder();
  if (q.error) throw q.error;
  const rows = q.data || [];
  if (rows.length >= 1000) throw new Error(`${label}: got >=1000 rows; one-shot read invalid`);
  return rows;
}

// Canonical dollar sum: add integer cents, divide by 100.
function centsSum(nums) {
  let c = 0;
  for (const n of nums) c += Math.round(Number(n || 0) * 100);
  return c / 100;
}

async function directBillbackActualByPeriod(accountKey) {
  const fyStart = FY.startISO;
  const fyEnd = FY.endISO;
  const preEnd = fyEnd < CAPTURE_CUTOVER_ISO ? fyEnd : isoBefore(CAPTURE_CUTOVER_ISO, 1);
  const postStart = fyStart > CAPTURE_CUTOVER_ISO ? fyStart : CAPTURE_CUTOVER_ISO;

  const preRows = fyStart <= preEnd ? await oneShot(() => SUPA
    .from("purchasing_actuals")
    .select("txn_date, gl_line_code, amount")
    .eq("account_key", accountKey)
    .eq("excluded", false)
    .gte("txn_date", fyStart)
    .lte("txn_date", preEnd)
    .range(0, ASSERT_CAP), `${accountKey} pre`) : [];

  const cardRows = postStart <= fyEnd ? await oneShot(() => SUPA
    .from("purchasing_actuals")
    .select("txn_date, gl_line_code, amount")
    .eq("account_key", accountKey)
    .eq("excluded", false)
    .eq("source", "rippling_spend")
    .gte("txn_date", postStart)
    .lte("txn_date", fyEnd)
    .range(0, ASSERT_CAP), `${accountKey} card`) : [];

  const invRows = postStart <= fyEnd ? await oneShot(() => SUPA
    .from("invoice_submissions")
    .select("submitted_at, gl_breakdown")
    .eq("account_key", accountKey)
    .gte("submitted_at", postStart)
    .lte("submitted_at", fyEnd)
    .range(0, ASSERT_CAP), `${accountKey} inv`) : [];

  const byP = new Map(); // period -> array of cent amounts
  const push = (p, amt) => {
    if (p == null || !amt) return;
    if (!byP.has(p)) byP.set(p, []);
    byP.get(p).push(amt);
  };
  for (const r of preRows) {
    if (deriveGlBucket(r.gl_line_code) !== "reimbursable") continue;
    push(periodOf(r.txn_date), r.amount);
  }
  for (const r of cardRows) {
    if (deriveGlBucket(r.gl_line_code) !== "reimbursable") continue;
    push(periodOf(r.txn_date), r.amount);
  }
  for (const r of invRows) {
    const items = Array.isArray(r.gl_breakdown) ? r.gl_breakdown : [];
    for (const it of items) {
      const code = it.gl_line_code || it.code;
      if (deriveGlBucket(code) !== "reimbursable") continue;
      push(periodOf(r.submitted_at), Number(it.amount || 0));
    }
  }
  // Collapse each period's amount list to a canonical cent sum.
  const out = new Map();
  for (const [p, amts] of byP) out.set(p, centsSum(amts));
  return { byP: out, rowCounts: { pre: preRows.length, card: cardRows.length, inv: invRows.length } };
}

async function directBillbackActualFoldPreseason(accountKey, firstGoalPeriod) {
  const { byP, rowCounts } = await directBillbackActualByPeriod(accountKey);
  if (!firstGoalPeriod || firstGoalPeriod <= 1) return { byP, rowCounts };
  // Fold preseason periods into firstGoalPeriod via cents.
  let preCents = 0;
  for (let p = 1; p < firstGoalPeriod; p += 1) {
    preCents += Math.round((byP.get(p) || 0) * 100);
  }
  const foldedCents = Math.round((byP.get(firstGoalPeriod) || 0) * 100) + preCents;
  const out = new Map(byP);
  for (let p = 1; p < firstGoalPeriod; p += 1) out.delete(p);
  out.set(firstGoalPeriod, foldedCents / 100);
  return { byP: out, rowCounts };
}

async function directProjectedMealsByPeriod(accountKey) {
  // Meals cross the 1000-row cap for some accounts (STL - FL has 1000+
  // service rows across the fiscal year), so a one-shot read is not an
  // option. Page with the same (service_date, service_id) tie-breaker
  // the entry uses - this is the uniqueness key that makes the page
  // boundaries deterministic. projected_count is a positive integer,
  // so the sum is order-invariant.
  const PAGE = 1000;
  const out = [];
  let from = 0;
  while (true) {
    const q = await SUPA
      .from("sc_daily_revenue")
      .select("service_date, service_id, projected_count, is_non_revenue")
      .eq("account_key", accountKey)
      .gte("service_date", FY.startISO)
      .lte("service_date", FY.endISO)
      .not("is_non_revenue", "is", true)
      .order("service_date")
      .order("service_id")
      .range(from, from + PAGE - 1);
    if (q.error) throw q.error;
    const rows = q.data || [];
    for (const r of rows) out.push(r);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  const byP = new Map();
  for (const r of out) {
    const n = Number(r.projected_count || 0);
    if (n === 0) continue;
    const p = periodOf(r.service_date);
    if (p == null) continue;
    byP.set(p, (byP.get(p) || 0) + n);
  }
  return { byP, rowCount: out.length };
}

// Proof JSON lookup.
const proofDir = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b/case");
function caseByPrefix(prefix) {
  const files = fs.readdirSync(proofDir).filter(f => f.startsWith(prefix));
  if (files.length !== 1) throw new Error("ambiguous: " + prefix + " -> " + files.join(","));
  return JSON.parse(fs.readFileSync(path.join(proofDir, files[0]), "utf8"));
}

function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return ((a - b) / denom) * 100;
}

function byteEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function verdictLabel(v1Match, enMatch) {
  if (v1Match && enMatch) return "both_eq_direct";
  if (enMatch) return "entry_eq_direct";
  if (v1Match) return "v1_eq_direct";
  return "neither_eq_direct";
}

const report = [];

// --- 1) CIN - OH billback.periods[0].actual (array index 0 = period_no 4 after fold) ---
{
  const d = caseByPrefix("017-g1-CIN - OH-currentYear-saloff");
  const A = d.A.body.billback;
  const V = d.V.body.billback;
  const idx = 0;
  const v1Actual = A.periods[idx].actual;
  const enActual = V.periods[idx].actual;
  const periodNo = A.periods[idx].period_no;
  const direct = await directBillbackActualFoldPreseason("CIN - OH", A.first_goal_period);
  const dirActual = direct.byP.get(periodNo);
  report.push({
    label: "CIN - OH billback.periods[0].actual (period_no=" + periodNo + ", preseason fold)",
    row_counts: direct.rowCounts,
    verdict: verdictLabel(byteEq(v1Actual, dirActual), byteEq(enActual, dirActual)),
    v1_pct_off_direct: pctDiff(v1Actual, dirActual),
    entry_pct_off_direct: pctDiff(enActual, dirActual),
  });
}

// --- 2) STL - MO billback.periods[5].actual (array index 5 = period_no 9) ---
{
  const d = caseByPrefix("029-g1-STL - MO-currentYear-saloff");
  const A = d.A.body.billback;
  const V = d.V.body.billback;
  const idx = 5;
  const v1Actual = A.periods[idx].actual;
  const enActual = V.periods[idx].actual;
  const periodNo = A.periods[idx].period_no;
  const direct = await directBillbackActualFoldPreseason("STL - MO", A.first_goal_period);
  const dirActual = direct.byP.get(periodNo);
  report.push({
    label: "STL - MO billback.periods[5].actual (period_no=" + periodNo + ")",
    row_counts: direct.rowCounts,
    verdict: verdictLabel(byteEq(v1Actual, dirActual), byteEq(enActual, dirActual)),
    v1_pct_off_direct: pctDiff(v1Actual, dirActual),
    entry_pct_off_direct: pctDiff(enActual, dirActual),
  });

  // Also the breakdown[0].amount discrepancy.
  const v1Food = (A.breakdown || []).find(b => b.label === "Food")?.amount;
  const enFood = (V.breakdown || []).find(b => b.label === "Food")?.amount;
  // Direct Food total = sum over all periods of reimbursable amounts whose
  // code maps to "Food" gl_codes.name. Easier: just sum ALL reimbursable
  // amounts and attribute via the same gl_codes label resolution as entry,
  // but that is the entire entry re-run. For THIS probe just report the
  // JSON equality of v1 vs entry; if they differ by float ULP, the cause
  // is the same (same push() summation inside byLabel).
  report.push({
    label: "STL - MO billback.breakdown[Food].amount (float-eq check only)",
    v1_entry_json_eq: byteEq(v1Food, enFood),
    pct_off: pctDiff(v1Food, enFood),
  });
}

// --- 3) STL - FL meal projection total for the year ---
{
  const d = caseByPrefix("022-g1-STL - FL-currentYear-salon");
  const A = d.A.body.billback;
  const V = d.V.body.billback;
  const annualGoal = A.annual_goal;
  const sumV1Goals = (A.periods || []).filter(x => x.goal != null).reduce((s, x) => s + x.goal, 0);
  const sumEnGoals = (V.periods || []).filter(x => x.goal != null).reduce((s, x) => s + x.goal, 0);

  const direct = await directProjectedMealsByPeriod("STL - FL");
  const goaledPeriods = [...direct.byP.entries()].filter(([, n]) => n > 0).map(([p]) => p).sort((a, b) => a - b);
  const totalMeals = goaledPeriods.reduce((s, p) => s + direct.byP.get(p), 0);
  // per-period direct goals: annualGoal * (meals_p / totalMeals)
  const directGoalsByP = new Map();
  for (const p of goaledPeriods) directGoalsByP.set(p, annualGoal * (direct.byP.get(p) / totalMeals));
  const sumDirectGoals = [...directGoalsByP.values()].reduce((s, g) => s + g, 0);

  // Per-period verdict.
  const perPeriod = [];
  for (const p of goaledPeriods) {
    const v1Goal = A.periods.find(x => x.period_no === p)?.goal ?? null;
    const enGoal = V.periods.find(x => x.period_no === p)?.goal ?? null;
    const dirGoal = directGoalsByP.get(p);
    perPeriod.push({
      period_no: p,
      verdict: verdictLabel(byteEq(v1Goal, dirGoal), byteEq(enGoal, dirGoal)),
      v1_pct_off: pctDiff(v1Goal, dirGoal),
      entry_pct_off: pctDiff(enGoal, dirGoal),
    });
  }

  report.push({
    label: "STL - FL meal projection (annual_goal = sum of period goals)",
    meals_row_count: direct.rowCount,
    goaled_period_count: goaledPeriods.length,
    sum_of_period_goals: {
      verdict: verdictLabel(byteEq(sumV1Goals, annualGoal), byteEq(sumEnGoals, annualGoal)),
      v1_vs_annual_pct: pctDiff(sumV1Goals, annualGoal),
      entry_vs_annual_pct: pctDiff(sumEnGoals, annualGoal),
      v1_vs_direct_pct: pctDiff(sumV1Goals, sumDirectGoals),
      entry_vs_direct_pct: pctDiff(sumEnGoals, sumDirectGoals),
    },
    per_period: perPeriod,
  });
}

// Write the (figure-free) report.
const destDir = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b");
fs.writeFileSync(path.join(destDir, "no_paging_check.json"), JSON.stringify(report, null, 2));

for (const r of report) {
  console.log(JSON.stringify(r, null, 2));
  console.log("---");
}
console.log("written:", path.join(destDir, "no_paging_check.json"));
