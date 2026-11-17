// For each of the 44 site_manager cases (group 4) in the main proof
// run, count:
//   - rows in the answer with line_code === "3100.2"
//   - keys whose name contains "salary" that are NOT null and NOT
//     false (any truthy value including 0, "", {}, [] counts as
//     "not null and not false" per the brief's language)
//
// Reads from ~/Downloads/KPI_V2_Handoff/proof_2a/case/*.json. Both
// A (v1) and V (V2) are read; counts are reported per case per side.
// A "row with line_code 3100.2" is counted wherever it appears in
// any array in the payload (statement_rows is the primary home, but
// the walk is general so derivatives are picked up too).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT_DIR = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2a");
const caseDir = path.join(OUT_DIR, "case");

function countLineCodeRows(node, code = "3100.2") {
  let n = 0;
  if (node == null) return 0;
  if (Array.isArray(node)) { for (const v of node) n += countLineCodeRows(v, code); return n; }
  if (typeof node !== "object") return 0;
  if (node.line_code === code) n++;
  for (const v of Object.values(node)) n += countLineCodeRows(v, code);
  return n;
}

function countSalaryKeys(node, out = { total: 0, set: 0 }) {
  if (node == null) return out;
  if (Array.isArray(node)) { for (const v of node) countSalaryKeys(v, out); return out; }
  if (typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    if (k.toLowerCase().includes("salary")) {
      out.total++;
      if (v !== null && v !== false) out.set++;
    }
    countSalaryKeys(v, out);
  }
  return out;
}

const files = fs.readdirSync(caseDir)
  .filter(f => f.endsWith(".json") && f.includes("-g4-"))
  .sort();

if (files.length === 0) {
  console.error("no g4 case files found");
  process.exit(1);
}

let totalSide = { A: { rows3100_2: 0, salaryTotal: 0, salarySet: 0 }, V: { rows3100_2: 0, salaryTotal: 0, salarySet: 0 } };
const perCase = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(caseDir, f), "utf8"));
  const sides = {};
  for (const side of ["A", "V"]) {
    const body = d[side]?.body ?? {};
    const r = countLineCodeRows(body, "3100.2");
    const s = countSalaryKeys(body);
    sides[side] = { rows3100_2: r, salaryKeys_total: s.total, salaryKeys_set: s.set };
    totalSide[side].rows3100_2 += r;
    totalSide[side].salaryTotal += s.total;
    totalSide[side].salarySet += s.set;
  }
  perCase.push({ file: f, A: sides.A, V: sides.V });
}

// Sum match / drift
let salaryMatchCount = 0;
let rowsMatchCount = 0;
for (const c of perCase) {
  if (c.A.rows3100_2 === c.V.rows3100_2) rowsMatchCount++;
  if (c.A.salaryKeys_set === c.V.salaryKeys_set) salaryMatchCount++;
}

const summary = {
  case_count: files.length,
  totals: {
    A_rows_3100_2: totalSide.A.rows3100_2,
    V_rows_3100_2: totalSide.V.rows3100_2,
    A_salary_keys_total: totalSide.A.salaryTotal,
    V_salary_keys_total: totalSide.V.salaryTotal,
    A_salary_keys_set: totalSide.A.salarySet,
    V_salary_keys_set: totalSide.V.salarySet,
  },
  matches: {
    cases_where_rows_match: rowsMatchCount,
    cases_where_salary_set_match: salaryMatchCount,
  },
  per_case: perCase,
};
fs.writeFileSync(path.join(OUT_DIR, "salary_counts.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ case_count: summary.case_count, totals: summary.totals, matches: summary.matches }, null, 2));
