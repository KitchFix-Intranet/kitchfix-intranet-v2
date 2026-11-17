// Planted-difference proof. Reads a passing case from the main
// 217-run and plants three minimal changes on the V side:
//   1. Change one top-level scalar number.
//   2. Remove one top-level scalar key.
//   3. Empty one non-empty top-level array.
// Then re-runs the SAME comparator the 217-case run used: the
// index-aware diffKeys from compare_answers.mjs. Reports every
// field path the diff reports, including the index-shift cascade
// an array change triggers. Written to
// ~/Downloads/KPI_V2_Handoff/proof_2a/planted/planted_diff.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OUT_DIR = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2a");

// SAME comparator as compare_answers.mjs's diffKeys. Recurses into
// objects AND arrays; an array-length change cascades through every
// index below the shift.
function diffKeys(a, b, prefix = "", out = [], limit = 200) {
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
      if (a[k] && b[k] && typeof a[k] === "object" && typeof b[k] === "object") {
        diffKeys(a[k], b[k], pa, out, limit);
      } else {
        out.push(pa);
      }
    }
  }
  return out;
}

const caseDir = path.join(OUT_DIR, "case");
const files = fs.readdirSync(caseDir).filter(f => f.endsWith(".json")).sort();
let chosen = null;
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(caseDir, f), "utf8"));
  if (d.A.status === d.V.status && JSON.stringify(d.A.body) === JSON.stringify(d.V.body)) {
    chosen = { file: f, data: d };
    break;
  }
}
if (!chosen) { console.error("no passing case to plant against"); process.exit(1); }

const data = JSON.parse(JSON.stringify(chosen.data));
const body = data.V.body;
const keys = Object.keys(body);

const numericKey = keys.find(k => typeof body[k] === "number");
if (numericKey) body[numericKey] = body[numericKey] + 1;

const removeKey = keys.find(k =>
  k !== numericKey && (typeof body[k] === "string" || typeof body[k] === "boolean")
);
if (removeKey) delete body[removeKey];

const arrayKey = keys.find(k => Array.isArray(body[k]) && body[k].length > 0 && k !== numericKey && k !== removeKey);
if (arrayKey) body[arrayKey] = [];

const paths = diffKeys(data.A.body, body);
const report = {
  base_case: chosen.file,
  comparator: "diffKeys (index-aware, same as 217-case run)",
  changed_number_key: numericKey,
  removed_key: removeKey,
  emptied_array_key: arrayKey,
  caught_count: paths.length,
  caught_paths: paths,
};
fs.mkdirSync(path.join(OUT_DIR, "planted"), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "planted", "planted_diff.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
