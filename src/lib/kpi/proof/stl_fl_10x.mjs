// Run the two STL - FL failing cases from the 217-case proof ten
// times each, back to back, with the same A-V-B pattern the main
// proof uses and the same index-aware comparator. Report per case:
// pass / fail / unstable counts.
//
// Train 2b: the engine takes fiscalYear + now as inputs. The script
// loads fiscal 2026 once from the fiscal_periods table and passes a
// fresh `now` on each getOverview call. v1 is unchanged - it reads
// the clock inside its own route.
//
// Usage:
//   node --import tsx src/lib/kpi/proof/stl_fl_10x.mjs \
//        [--env-file=/path/to/.env.local]
//
// Does NOT explain the result away. The result is what it is.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const V1_BASE = process.env.V1_BASE || "http://localhost:3100";
const OUT_DIR = path.join(os.homedir(), "Downloads/KPI_V2_Handoff/proof_2b");

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

async function askV1(params) {
  const q = new URLSearchParams(params);
  const url = `${V1_BASE}/api/kpi/overview?${q.toString()}`;
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url);
      const t = await r.text();
      let b; try { b = JSON.parse(t); } catch { b = { _raw: t.slice(0, 500) }; }
      return { status: r.status, body: b };
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 2000)); }
  }
  throw lastErr;
}

const SHARED_SUPA = serviceClient();
const FY2026 = await loadFiscalYear(SHARED_SUPA, 2026);

async function askV2(params, caller, todayISO) {
  const res = await getOverview({
    supa: SHARED_SUPA,
    today: todayISO,
    now: new Date(),
    fiscalYear: FY2026,
    caller,
    query: {
      account: params.account,
      preview: params.preview,
      include_salary: params.include_salary === "1" ? "1" : "",
      debug: params.debug,
      range: params.range,
      start: params.start,
      end: params.end,
    },
  });
  return { status: res.status, body: res.body };
}

function stripRD(body) {
  if (!body || typeof body !== "object") return body;
  if ("regional_directors_display" in body) {
    const { regional_directors_display, ...rest } = body;
    return rest;
  }
  return body;
}

function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function redact(v) {
  return "sha256:" + crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 16);
}
const REDACT_KEYS_SUBSTR = ["email", "drive_url", "submitter"];
const REDACT_VALUE_PATTERNS = [
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  /^https?:\/\/(drive\.google\.com|docs\.google\.com)\//i,
];
function walkRedact(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(walkRedact);
  if (typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();
      if (REDACT_KEYS_SUBSTR.some(s => lk.includes(s)) && typeof v === "string" && v.length) out[k] = redact(v);
      else if (typeof v === "string" && REDACT_VALUE_PATTERNS.some(p => p.test(v))) out[k] = redact(v);
      else out[k] = walkRedact(v);
    }
    return out;
  }
  return node;
}

// Seed once for todayISO.
const seed = await askV1({});
const todayISO = seed.body?.todayISO;
if (!todayISO) { console.error("v1 no todayISO"); process.exit(2); }
const curP = periods.currentPeriodNo(todayISO, FY2026);

const CASES = [
  {
    id: "g1-STL - FL-currentPeriod-salon",
    caller: { role: "corporate", scope: null, can_see_salary: true },
    params: {
      account: "STL - FL",
      start: periods.periodStartISO(curP, FY2026),
      end: periods.periodEndISO(curP, FY2026),
      include_salary: "1",
    },
  },
  {
    id: "g1-STL - FL-lastVerified-salon",
    caller: { role: "corporate", scope: null, can_see_salary: true },
    params: null, // filled below from the live kpi_period_status read
  },
];

// Fill the lastVerified params from the live DB.
const vq = await SHARED_SUPA
  .from("kpi_period_status")
  .select("period_no, verified_at")
  .eq("fiscal_year", 2026)
  .not("verified_at", "is", null)
  .order("period_no", { ascending: false })
  .limit(1);
const lastVerifiedP = vq.data?.[0]?.period_no;
if (!lastVerifiedP) { console.error("no verified period found"); process.exit(2); }
CASES[1].params = {
  account: "STL - FL",
  start: periods.periodStartISO(lastVerifiedP, FY2026),
  end: periods.periodEndISO(lastVerifiedP, FY2026),
  include_salary: "1",
};

console.log(`todayISO: ${todayISO}`);
console.log(`currentPeriodNo: ${curP}`);
console.log(`lastVerifiedPeriodNo (from kpi_period_status.verified_at): ${lastVerifiedP}`);
console.log("");

const RUNS = 10;
const perCaseLog = [];
for (const c of CASES) {
  let pass = 0, fail = 0, unstable = 0;
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    let A = await askV1(c.params);
    const t = A.body?.todayISO || todayISO;
    const V = await askV2(c.params, c.caller, t);
    let B = await askV1(c.params);
    let stable = deepEq(stripRD(A.body), stripRD(B.body));
    let attempts = 1;
    let v1Side = null;
    while (!stable && attempts < 3) {
      v1Side = { aFirst: A.body, bSecond: B.body };
      A = B;
      B = await askV1(c.params);
      stable = deepEq(stripRD(A.body), stripRD(B.body));
      attempts++;
    }
    const aR = walkRedact(stripRD(A.body));
    const vR = walkRedact(stripRD(V.body));
    let status;
    if (!stable) { status = "unstable"; unstable++; }
    else if (deepEq(aR, vR) && A.status === V.status) { status = "pass"; pass++; }
    else { status = "fail"; fail++; }
    runs.push({ i, status, attempts });
    console.log(`  [${c.id}] run ${i}: ${status} (attempts=${attempts})`);
  }
  perCaseLog.push({ id: c.id, pass, fail, unstable, runs });
}

const outPath = path.join(OUT_DIR, "stl_fl_10x.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  todayISO, curP, lastVerifiedP, cases: perCaseLog,
}, null, 2));

console.log("");
console.log("SUMMARY:");
for (const c of perCaseLog) {
  console.log(`  ${c.id}: pass=${c.pass} fail=${c.fail} unstable=${c.unstable}`);
}
console.log("");
console.log(`written: ${outPath}`);
