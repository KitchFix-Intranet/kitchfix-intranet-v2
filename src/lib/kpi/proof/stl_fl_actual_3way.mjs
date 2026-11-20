// STL - FL bill-back actual, per period, three-way: v1 vs entry vs
// direct DB sum. The purchasing side (reimbursable actuals) crosses
// the 1,000-row cap for STL - FL (purchasing_actuals pre-cutover 1,783
// rows in FY2026), so v1's single-column `.order("txn_date")` pages
// without a unique sort - same defect proven on v1's sc_daily_revenue
// read. Expected: entry = direct on every period; v1 off by a
// paging-boundary amount on the periods that straddle a page cut.
//
// Percents only. No dollar figures.

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

// Paged walk with a UNIQUE sort chain. Every read uses the uuid id as
// the tie-breaker on top of the date, same as billback.ts and
// pagedSelect's rule.
async function walkUnique(builderWithId) {
  const out = [];
  let from = 0;
  while (true) {
    const q = await builderWithId(from, from + PAGE - 1);
    if (q.error) throw q.error;
    const rows = q.data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function directActualByPeriod(acct) {
  const fyStart = FY.startISO, fyEnd = FY.endISO;
  const preEnd = fyEnd < CAPTURE_CUTOVER_ISO ? fyEnd : isoBefore(CAPTURE_CUTOVER_ISO, 1);
  const postStart = fyStart > CAPTURE_CUTOVER_ISO ? fyStart : CAPTURE_CUTOVER_ISO;

  const preRows = fyStart <= preEnd ? await walkUnique((lo, hi) => SUPA
    .from("purchasing_actuals")
    .select("id, txn_date, gl_line_code, amount")
    .eq("account_key", acct).eq("excluded", false)
    .gte("txn_date", fyStart).lte("txn_date", preEnd)
    .order("txn_date").order("id").range(lo, hi)) : [];

  const cardRows = postStart <= fyEnd ? await walkUnique((lo, hi) => SUPA
    .from("purchasing_actuals")
    .select("id, txn_date, gl_line_code, amount")
    .eq("account_key", acct).eq("excluded", false).eq("source", "rippling_spend")
    .gte("txn_date", postStart).lte("txn_date", fyEnd)
    .order("txn_date").order("id").range(lo, hi)) : [];

  const invRows = postStart <= fyEnd ? await walkUnique((lo, hi) => SUPA
    .from("invoice_submissions")
    .select("id, submitted_at, gl_breakdown")
    .eq("account_key", acct)
    .gte("submitted_at", postStart).lte("submitted_at", fyEnd)
    .order("submitted_at").order("id").range(lo, hi)) : [];

  const byPcents = new Map();
  const push = (p, amt) => {
    if (p == null || !amt) return;
    const c = Math.round(Number(amt) * 100);
    byPcents.set(p, (byPcents.get(p) || 0) + c);
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
  return {
    byP: new Map([...byPcents].map(([p, c]) => [p, c / 100])),
    rowCounts: { pre: preRows.length, card: cardRows.length, inv: invRows.length },
  };
}

function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return ((a - b) / denom) * 100;
}

// Load the saved proof answers for STL - FL currentYear.
const caseFile = fs.readdirSync(path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b/case"))
  .find(f => f.includes("g1-STL - FL-currentYear-saloff"));
const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b/case", caseFile), "utf8"));
const A = d.A.body.billback;
const V = d.V.body.billback;
const direct = await directActualByPeriod("STL - FL");

// Fold the preseason into first_goal_period for v1/entry parity (both
// do this fold). STL - FL first_goal_period = 1 in current data, so
// the fold is a no-op, but we handle it defensively.
function foldPreseason(byP, firstGoal) {
  if (!firstGoal || firstGoal <= 1) return byP;
  let preCents = 0;
  for (let p = 1; p < firstGoal; p += 1) preCents += Math.round((byP.get(p) || 0) * 100);
  const out = new Map(byP);
  for (let p = 1; p < firstGoal; p += 1) out.delete(p);
  const folded = Math.round((byP.get(firstGoal) || 0) * 100) + preCents;
  out.set(firstGoal, folded / 100);
  return out;
}

const firstGoalPeriod = A.first_goal_period;
const directFolded = foldPreseason(direct.byP, firstGoalPeriod);

const report = {
  account: "STL - FL",
  first_goal_period: firstGoalPeriod,
  row_counts: direct.rowCounts,
  per_period: [],
};

for (const pRow of A.periods) {
  const periodNo = pRow.period_no;
  const v1Actual = pRow.actual;
  const enRow = V.periods.find(r => r.period_no === periodNo);
  const enActual = enRow?.actual;
  const dirActual = directFolded.get(periodNo) ?? 0;
  const byteEntryEqDirect = JSON.stringify(enActual) === JSON.stringify(dirActual);
  const byteV1EqDirect = JSON.stringify(v1Actual) === JSON.stringify(dirActual);
  const absEntry = Math.abs(Number(enActual) - Number(dirActual));
  const absV1 = Math.abs(Number(v1Actual) - Number(dirActual));
  let verdict;
  if (byteEntryEqDirect && byteV1EqDirect) verdict = "both_eq_direct";
  else if (absEntry < 1e-6 && absV1 < 1e-6) verdict = "float_ulp_noise (both match to the cent)";
  else if (absEntry < 1e-6) verdict = "entry_eq_direct";
  else if (absV1 < 1e-6) verdict = "v1_eq_direct";
  else verdict = "neither_eq_direct";
  report.per_period.push({
    period_no: periodNo,
    verdict,
    v1_pct_off_direct: pctDiff(Number(v1Actual), Number(dirActual)),
    entry_pct_off_direct: pctDiff(Number(enActual), Number(dirActual)),
  });
}

const destDir = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b");
fs.writeFileSync(path.join(destDir, "stl_fl_actual_3way.json"), JSON.stringify(report, null, 2));
for (const r of report.per_period) {
  console.log(`P${r.period_no}: ${r.verdict} | v1 ${r.v1_pct_off_direct.toExponential(2)}%, entry ${r.entry_pct_off_direct.toExponential(2)}%`);
}
console.log("");
console.log("row_counts (STL - FL reimbursable reads):", report.row_counts);
console.log("written:", path.join(destDir, "stl_fl_actual_3way.json"));
