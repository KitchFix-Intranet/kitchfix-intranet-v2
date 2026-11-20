// Offline re-check of the 182 saved cases. Reads the post-redact A /
// V bodies written by compare_answers.mjs and compares them STRICTLY
// (no array canonicalisation, no object-key canonicalisation).
//
// For every case that then differs, each differing path is classed:
//   - "real_diff"               : scalar or structural difference
//   - "same_rows_different_order": array path whose elements form
//     the same multiset on both sides, order differs
//   - "same_keys_different_order": object dict whose keys form the
//     same set with identical per-key values, iteration order differs
//
// Proof of "same rows, different order":
//   sort(A[path]) === sort(V[path]) by JSON.stringify(element).
// Proof of "same keys, different order":
//   sortedKeys(A[path]) deep-equal sortedKeys(V[path]).
//
// Each same_rows path names the read that feeds it (grep the engine)
// and the tie-breaker train 2c added. Each same_keys path names the
// dict key and where it is built.
//
// This classifier is NOT a pass/fail rule. compare_answers.mjs's
// canonicalisation is. This re-check exists to document what the
// canonicalisation masks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CASE_DIR = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2c/case");
const files = fs.readdirSync(CASE_DIR).filter(f => f.endsWith(".json")).sort();

// Paths known to be fed by a 2c-added tie-breaker (grep-anchored).
// Any "same_rows_different_order" or "same_keys_different_order"
// path must map to one of these, or the case does not qualify under
// the "tie-broken read" rule.
const KNOWN_TIE_BREAKER_SOURCES = {
  // Labor
  "actuals":            { file: "labor/loaders.ts::paginateActuals + labor/salaryBoard.ts::loadSalaryActuals", sort: "(week_start, account_key, worker_id) + (account_key, week_start, worker_id); salary tie-breaker added in 2c commit 2" },
  "workers":            { file: "labor/board.ts::buildBoard dict keyed by worker_id; built from actuals iteration", sort: "iteration order follows actuals sort chain above" },
  "worker_week_rates":  { file: "labor/workerWeekRates.ts::loadWorkerWeekRates dict keyed by workerId|weekStart", sort: "(kind, rippling_id) on presence PK; (rippling_id, id) on raw pay segments (fixed to include id tie-breaker in 2c round 2 after rippling_id proved non-unique: 26,527 rows / 22,099 distinct = 4,428 repeats)" },
  "name_availability":  { file: "labor/route.js resolver object; derived fields only", sort: "n/a - not an array / dict" },
  // Purchasing (common)
  "pending":            { file: "purchasing/loaders.ts::loadPending array", sort: "(source_line_id) unique per rippling_spend row" },
  "weekly":             { file: "purchasing/loaders.ts::paginateWeekly array", sort: "(account_key, week_start, gl_line_code, gl_bucket)" },
  "actuals_by_week":    { file: "purchasing/loaders.ts::paginateActuals derived", sort: "parent id chain" },
  "accounts_directory": { file: "labor/route.js + purchasing/route.js accounts fetch", sort: "(team_key) unique PK; 2c added .order(team_key)" },
  "ledger_rows":        { file: "purchasing/loaders.ts::loadLedgerRows", sort: "(txn_date, id)" },
  "card_charges":       { file: "purchasing/loaders.ts::loadCardCharges rows", sort: "(txn_date, id)" },
  "vendor_rollup":      { file: "purchasing/loaders.ts::loadVendorRollup", sort: "(id)" },
  "compliance":         { file: "purchasing/loaders.ts::loadCompliance array", sort: "(purchased_at, id)" },
  // Drill lines
  "drill_lines":        { file: "purchasing/loaders.ts::paginateActuals drill-lines branch", sort: "(txn_date, id)" },
  // Per-period / per-week sub-arrays
  "weeks":              { file: "built in buildBoard / withSalary; iteration order follows actuals + budget_periods", sort: "upstream tie-break + fiscal-week walk" },
  "weeks_weekly":       { file: "purchasing/loaders.ts::paginateWeekly result", sort: "see weekly above" },
};

function diff(a, b, p = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a === null || b === null || typeof a !== typeof b) return [{ path: p, kind: "scalar_or_type" }];
  if (Array.isArray(a) && Array.isArray(b)) {
    // Try multiset equality via sorted JSON of each element.
    const sa = [...a].map(x => JSON.stringify(x)).sort();
    const sb = [...b].map(x => JSON.stringify(x)).sort();
    if (sa.length === sb.length && sa.every((x, i) => x === sb[i])) {
      return [{ path: p, kind: "same_rows_different_order", length: a.length }];
    }
    // Different content. Recurse by index to count scalar diffs below.
    const out = [{ path: p, kind: "array_content_diff", a_len: a.length, b_len: b.length }];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      out.push(...diff(a[i], b[i], `${p}[${i}]`));
    }
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [{ path: p, kind: "array_vs_non_array" }];
  if (typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    const keysSame = keysA.length === keysB.length && [...keysA].sort().every((k, i) => k === [...keysB].sort()[i]);
    if (keysSame) {
      // Keys identical; check if values are identical (perhaps reordered children).
      let allValuesEqual = true;
      const childDiffs = [];
      for (const k of keysA) {
        const sub = diff(a[k], b[k], p ? `${p}.${k}` : k);
        if (sub.length > 0) {
          allValuesEqual = false;
          childDiffs.push(...sub);
        }
      }
      // If all children match individually but the serialised stringify differs,
      // it is a key-insertion-order diff.
      if (allValuesEqual && JSON.stringify(a) !== JSON.stringify(b)) {
        return [{ path: p, kind: "same_keys_different_order", size: keysA.length }];
      }
      return childDiffs;
    }
    // Keys differ. Report the structural diff.
    const out = [{ path: p, kind: "object_keys_differ", only_in_a: keysA.filter(k => !keysB.includes(k)), only_in_b: keysB.filter(k => !keysA.includes(k)) }];
    const union = new Set([...keysA, ...keysB]);
    for (const k of union) {
      out.push(...diff(a[k], b[k], p ? `${p}.${k}` : k));
    }
    return out;
  }
  return [{ path: p, kind: "scalar_diff" }];
}

// Classify a case's top-level diffs. Return { class, perPath }.
function classifyCase(d) {
  const diffs = diff(d.A.body, d.V.body);
  if (diffs.length === 0) return { verdict: "exact", paths: [] };
  // Collect unique top-level paths (first segment).
  const topLevel = new Map();
  for (const entry of diffs) {
    const top = entry.path.split(/[.[]/)[0];
    const kind = entry.kind;
    const prev = topLevel.get(top) || { exact_children: 0, same_rows: 0, same_keys: 0, scalar_diff: 0, array_content_diff: 0, object_keys_differ: 0 };
    if (kind === "same_rows_different_order") prev.same_rows += 1;
    else if (kind === "same_keys_different_order") prev.same_keys += 1;
    else if (kind === "scalar_diff" || kind === "scalar_or_type") prev.scalar_diff += 1;
    else if (kind === "array_content_diff") prev.array_content_diff += 1;
    else if (kind === "object_keys_differ") prev.object_keys_differ += 1;
    topLevel.set(top, prev);
  }
  const paths = [];
  let hasRealDiff = false;
  for (const [top, counts] of topLevel) {
    const totalReorder = counts.same_rows + counts.same_keys;
    const totalReal = counts.scalar_diff + counts.array_content_diff + counts.object_keys_differ;
    const tb = KNOWN_TIE_BREAKER_SOURCES[top] || null;
    const path = {
      top,
      same_rows_different_order: counts.same_rows,
      same_keys_different_order: counts.same_keys,
      scalar_or_structural: totalReal,
      tie_broken_source: tb,
    };
    paths.push(path);
    if (totalReal > 0) hasRealDiff = true;
  }
  const verdict = hasRealDiff ? "real_diff" : "same_rows_different_order";
  return { verdict, paths };
}

const results = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(CASE_DIR, f), "utf8"));
  const id = d.case?.id || f;
  const route = d.case?.route || "?";
  const group = d.case?.group || "?";
  const r = classifyCase(d);
  results.push({ id, group, route, verdict: r.verdict, paths: r.paths });
}

const summary = {};
for (const r of results) summary[r.verdict] = (summary[r.verdict] || 0) + 1;

console.log("OFFLINE STRICT RE-CHECK");
console.log("Total cases:", results.length);
console.log("By verdict:", JSON.stringify(summary));
console.log("");

// Group paths that showed up in same_rows_different_order.
const pathCounts = new Map();
for (const r of results) {
  if (r.verdict !== "same_rows_different_order") continue;
  for (const p of r.paths) {
    if (p.same_rows_different_order > 0 || p.same_keys_different_order > 0) {
      const key = p.top;
      const prev = pathCounts.get(key) || { cases: 0, tie_broken_source: p.tie_broken_source };
      prev.cases += 1;
      pathCounts.set(key, prev);
    }
  }
}

console.log("Paths with 'same rows, different order' (across the cases that showed it):");
for (const [top, info] of [...pathCounts.entries()].sort((a, b) => b[1].cases - a[1].cases)) {
  console.log(`  ${top}: ${info.cases} case(s)`);
  if (info.tie_broken_source) {
    console.log(`    fed by: ${info.tie_broken_source.file}`);
    console.log(`    sort:   ${info.tie_broken_source.sort}`);
  } else {
    console.log(`    fed by: UNKNOWN - needs mapping`);
  }
}
console.log("");

// If any case has real_diff, list it.
const realDiffs = results.filter(r => r.verdict === "real_diff");
if (realDiffs.length > 0) {
  console.log("REAL DIFFS (stop + report):");
  for (const r of realDiffs) {
    console.log(`  ${r.id} (${r.group}):`);
    for (const p of r.paths) {
      if (p.scalar_or_structural > 0) {
        console.log(`    - ${p.top}: ${p.scalar_or_structural} scalar/structural diff(s)`);
      }
    }
  }
} else {
  console.log("No real diffs.");
}

const dest = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2c/offline_recheck.json");
fs.writeFileSync(dest, JSON.stringify({ summary, results, pathCounts: [...pathCounts.entries()] }, null, 2));
console.log("");
console.log("written:", dest);
