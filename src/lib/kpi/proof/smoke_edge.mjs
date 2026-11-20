// Three smoke runs at the edge of a year. Report-only - the engine is
// NOT touched to make these pass. For each scenario, call the entry
// against TBR - FL, STL - FL, and ALL as corporate, on "Current year"
// (FYTD) and on the period today falls in. Capture:
//   - status (200 / 400 / 500)
//   - whether it threw, with the scope
//   - the answer's period + period state
//   - whether any date in the answer falls outside fy
//
// Never prints a figure.

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
const { getOverview } = await import(path.resolve(HERE, "../entry.ts"));
const periods = await import(path.resolve(HERE, "../labor/periods.ts"));
const { loadFiscalYear } = await import(path.resolve(HERE, "../shared/fiscalYear.ts"));

const SUPA = serviceClient();
const FY2026 = await loadFiscalYear(SUPA, 2026);
const FY2027 = await loadFiscalYear(SUPA, 2027);

const SCENARIOS = [
  { label: "A. fy=2026, today=2026-12-28",  fy: FY2026, today: "2026-12-28" },
  { label: "B. fy=2026, today=2027-01-15",  fy: FY2026, today: "2027-01-15" },
  { label: "C. fy=2027, today=2027-01-15",  fy: FY2027, today: "2027-01-15" },
];

const ACCOUNTS = ["TBR - FL", "STL - FL", "ALL"];
const CALLER = { role: "corporate", scope: null, can_see_salary: true };

// Walk an object, collect every YYYY-MM-DD string; test against fy bounds.
function anyDateOutsideFy(node, fy, acc = { outside: false, firstOutside: null, firstOutsidePath: null, scanned: 0 }, path = "") {
  if (acc.outside && acc.scanned > 200) return acc;
  if (node == null) return acc;
  if (typeof node === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(node)) {
      acc.scanned += 1;
      if (node < fy.startISO || node > fy.endISO) {
        if (!acc.outside) {
          acc.outside = true;
          acc.firstOutside = node;
          acc.firstOutsidePath = path;
        }
      }
    }
    return acc;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) anyDateOutsideFy(node[i], fy, acc, `${path}[${i}]`);
    return acc;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) anyDateOutsideFy(v, fy, acc, path ? `${path}.${k}` : k);
    return acc;
  }
  return acc;
}

const now = new Date();
const out = [];

for (const sc of SCENARIOS) {
  const periodToday = periods.periodOf(sc.today, sc.fy);
  for (const account of ACCOUNTS) {
    for (const rangeKind of ["fytd", "period"]) {
      const q = { account };
      if (rangeKind === "fytd") q.range = "fytd";
      else if (periodToday != null) q.range = `period:${periodToday}`;
      else q.range = "fytd"; // no period today in fy => fall back
      let res, threw = null;
      try {
        res = await getOverview({
          supa: SUPA,
          today: sc.today,
          now,
          fiscalYear: sc.fy,
          caller: CALLER,
          query: q,
        });
      } catch (e) {
        threw = { name: e?.name, message: e?.message, scope: "getOverview_throw" };
      }
      let periodSeen = null;
      let periodState = null;
      let outsideScan = { outside: false };
      if (res?.body) {
        if (res.body.ok === true) {
          periodSeen = res.body?.range?.period_no ?? null;
          periodState = res.body?.period_state ?? null;
          outsideScan = anyDateOutsideFy(res.body, sc.fy);
        }
      }
      out.push({
        scenario: sc.label,
        fy: sc.fy.year,
        today: sc.today,
        period_today: periodToday,
        account,
        q,
        status: res?.status ?? null,
        threw: threw || (res?.body?.error ? { message: res.body.error, scope: res.body.scope } : null),
        period_no_in_answer: periodSeen,
        period_state_in_answer: periodState,
        any_date_outside_fy: outsideScan.outside,
        first_outside_date: outsideScan.firstOutside,
        first_outside_path: outsideScan.firstOutsidePath,
      });
    }
  }
}

const dest = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b/smoke_edge.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2));

console.log("SCENARIO | ACCOUNT | RANGE | status | threw | period_no | state | date_outside_fy");
for (const r of out) {
  console.log([
    r.scenario, r.account, r.q.range, r.status,
    r.threw ? JSON.stringify(r.threw) : "-",
    r.period_no_in_answer ?? "-",
    r.period_state_in_answer ?? "-",
    r.any_date_outside_fy ? `YES (${r.first_outside_path}=${r.first_outside_date})` : "no",
  ].join(" | "));
}
console.log("");
console.log("written:", dest);
