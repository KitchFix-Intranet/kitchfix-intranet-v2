// src/lib/kpi/proof/screen_capture.mjs
//
// Train 2d-1 proof — Part 1: capture.
//
// Spins up v1 (TEST_MODE) in the writable clone at
// ~/dev/kitchfix-intranet, drives Playwright (from the read-only v1 pin)
// against /kpi/overview for every case, records every /api/kpi/* payload
// the page received, and reads every figure off the rendered DOM.
//
// Nothing here edits a v1 file. Nothing is committed. All captured
// artefacts are written under ~/Downloads/KPI_V2_Handoff/proof_2d1/
// per the prompt. The paired screen_compare.mjs feeds the captured
// payloads into V2's screen model + formatters and compares text-exact.
//
// Usage:
//   node --env-file=/Users/kevinfietek/dev/kitchfix-intranet/.env.local \
//        src/lib/kpi/proof/screen_capture.mjs
//
// Env fallback: if --env-file is not supplied, the script will parse
// .env.local itself (same pattern as the other proof scripts here).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

// ─────────────────────────────────────────────────────────────────────
// Paths + constants
// ─────────────────────────────────────────────────────────────────────

const V1_CLONE = "/Users/kevinfietek/dev/kitchfix-intranet";
const V1_READONLY_PLAYWRIGHT =
  "/Users/kevinfietek/dev/kf-kpi-readonly/node_modules/playwright/index.mjs";
const OUT_ROOT =
  "/Users/kevinfietek/Downloads/KPI_V2_Handoff/proof_2d1";
const OUT_PAYLOADS = path.join(OUT_ROOT, "payloads");
const OUT_SCREENS = path.join(OUT_ROOT, "screens");
const OUT_SCREENS_TXT = path.join(OUT_ROOT, "screens-text");

for (const d of [OUT_ROOT, OUT_PAYLOADS, OUT_SCREENS, OUT_SCREENS_TXT]) {
  fs.mkdirSync(d, { recursive: true });
}

// Default log prefix.
const log = (...a) => console.log("[capture]", ...a);

// ─────────────────────────────────────────────────────────────────────
// Env loading
// ─────────────────────────────────────────────────────────────────────

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

// Node --env-file already parsed; still accept an --env-file= override.
const envArg = process.argv.find((a) => a.startsWith("--env-file="));
if (envArg) loadEnvFile(envArg.slice("--env-file=".length));
// Fall back to the writable clone's .env.local so the Supabase + Rippling
// keys are present without the user needing to pass --env-file.
loadEnvFile(path.join(V1_CLONE, ".env.local"));

// Supabase URL: V1 ships only SUPABASE_URL; V2 reads NEXT_PUBLIC_SUPABASE_URL.
// Mirror so either is set regardless of which env was loaded.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
}
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error(
    "[capture] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL ABSENT — point --env-file at the v1 clone .env.local",
  );
  process.exit(2);
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[capture] SUPABASE_SERVICE_ROLE_KEY ABSENT");
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────
// Scope list + case construction
// ─────────────────────────────────────────────────────────────────────

const SCOPES = [
  "CIN - AZ",
  "CIN - KY",
  "CIN - OH",
  "STL - FL",
  "STL - MO",
  "TBJ - FL",
  "TBJ - NY",
  "TBR - FL",
  "TXR - AZ",
  "TXR - TX - H",
  "TXR - TX - V",
  "ALL",
  "EAST",
  "WEST",
];

const FY_START_ISO = "2025-12-29";

function periodStartISO(pNo) {
  const start = new Date(FY_START_ISO + "T00:00:00Z").getTime();
  const d = new Date(start + (pNo - 1) * 28 * 86400000);
  return d.toISOString().slice(0, 10);
}
function periodEndISO(pNo) {
  const start = new Date(FY_START_ISO + "T00:00:00Z").getTime();
  const d = new Date(start + pNo * 28 * 86400000 - 86400000);
  return d.toISOString().slice(0, 10);
}
function r93FytdEndISO(todayISO) {
  // Simplified: last period whose close is >= 8d before today.
  const todayMs = new Date(todayISO + "T00:00:00Z").getTime();
  for (let p = 13; p >= 1; p -= 1) {
    const endMs = new Date(periodEndISO(p) + "T00:00:00Z").getTime();
    if (endMs + 8 * 86400000 <= todayMs) {
      return periodEndISO(p);
    }
  }
  return periodEndISO(1);
}

async function lastVerifiedPeriod() {
  // Via supabase REST — avoid importing from V2 code paths so this
  // script stays shell-level.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE creds ABSENT");
  const qs =
    "/rest/v1/kpi_period_status?fiscal_year=eq.2026&verified_at=not.is.null&order=period_no.desc&limit=1";
  const res = await fetch(url + qs, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) throw new Error(`kpi_period_status HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("no verified periods in FY2026");
  }
  return rows[0].period_no;
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") continue;
    p.set(k, String(v));
  }
  return p.toString();
}

function caseId(prefix, scope, salary, extra) {
  const base = `${prefix}__${scope.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const sal = salary === 1 ? "sal1" : "sal0";
  return extra ? `${base}__${sal}__${extra}` : `${base}__${sal}`;
}

async function buildCases() {
  const lvp = await lastVerifiedPeriod();
  log("last verified period in FY2026 =", lvp);
  const cases = [];

  // S1 (28): last verified period x 14 x salary on/off
  for (const scope of SCOPES) {
    for (const sal of [0, 1]) {
      cases.push({
        case_id: caseId("S1", scope, sal),
        group: "S1",
        scope,
        salary: sal,
        url_params: {
          account: scope,
          start: periodStartISO(lvp),
          end: periodEndISO(lvp),
          label: `P${lvp}`,
          include_salary: sal === 1 ? "1" : "",
        },
      });
    }
  }

  // S2 (28): current year (fytd) x 14 x salary on/off
  const today = new Date().toISOString().slice(0, 10);
  const fytdEnd = r93FytdEndISO(today);
  for (const scope of SCOPES) {
    for (const sal of [0, 1]) {
      cases.push({
        case_id: caseId("S2", scope, sal),
        group: "S2",
        scope,
        salary: sal,
        url_params: {
          account: scope,
          start: FY_START_ISO,
          end: fytdEnd,
          include_salary: sal === 1 ? "1" : "",
        },
      });
    }
  }

  // S3 (28): P6 x 14 x salary on/off
  for (const scope of SCOPES) {
    for (const sal of [0, 1]) {
      cases.push({
        case_id: caseId("S3", scope, sal),
        group: "S3",
        scope,
        salary: sal,
        url_params: {
          account: scope,
          start: periodStartISO(6),
          end: periodEndISO(6),
          label: "P6",
          include_salary: sal === 1 ? "1" : "",
        },
      });
    }
  }

  // S4 (8): last verified period, (site_leader, salaried_manager) x
  // (CIN - AZ, TBJ - FL, TBR - FL, TXR - AZ).
  const s4Scopes = ["CIN - AZ", "TBJ - FL", "TBR - FL", "TXR - AZ"];
  const s4Roles = ["site_leader", "salaried_manager"];
  for (const scope of s4Scopes) {
    for (const role of s4Roles) {
      cases.push({
        case_id: `S4__${scope.replace(/[^A-Za-z0-9]+/g, "_")}__${role}`,
        group: "S4",
        scope,
        salary: 0,
        role,
        url_params: {
          account: scope,
          start: periodStartISO(lvp),
          end: periodEndISO(lvp),
          label: `P${lvp}`,
          _test_role: role,
          _test_scope: scope,
        },
      });
    }
  }

  return { cases, lvp, today, fytdEnd };
}

// ─────────────────────────────────────────────────────────────────────
// Free port + dev server
// ─────────────────────────────────────────────────────────────────────

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function spawnDevServer(port) {
  log(`starting next dev on port ${port} inside ${V1_CLONE}`);
  const env = {
    ...process.env,
    TEST_MODE: "true",
    PORT: String(port),
    VERCEL: "",
  };
  const child = spawn("npm", ["run", "dev"], {
    cwd: V1_CLONE,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  child.stdout.on("data", (b) => {
    const s = b.toString();
    if (/error|Error/.test(s)) log("v1-stdout:", s.trim().slice(0, 400));
  });
  child.stderr.on("data", (b) => {
    const s = b.toString();
    if (/error|Error|warn/i.test(s))
      log("v1-stderr:", s.trim().slice(0, 400));
  });
  const ok = await waitForReady(`http://localhost:${port}/`, 90000);
  if (!ok) {
    try {
      child.kill("SIGTERM");
    } catch {}
    throw new Error("v1 dev server did not become ready within 90s");
  }
  log("v1 dev server ready");
  return child;
}

function killDevServer(child) {
  try {
    child.kill("SIGTERM");
  } catch {}
  // Also kill any lingering next/node on the port. Best effort.
}

// ─────────────────────────────────────────────────────────────────────
// Playwright driving
// ─────────────────────────────────────────────────────────────────────

const FIGURE_REGEX =
  /\$[\d,]+(?:\.\d+)?|[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?\s*%|[0-9]+(?:\.[0-9]+)?\s*(?:hrs?|h\b)|on budget|on target|(?:over|under|above|below|ahead|behind)\s+(?:budget|target|projection)|\d+\s+days? ago|\d+\s+day ago|\d+\s+(?:person|people)/gi;

// Blocks we filter from BOTH sides before compare (see screen_compare).
// The list of landmark attrs we treat as page "blocks."
const BLOCK_ATTRS = new Set([
  "cards-row",
  "status-line",
  "settling-strip",
  "overdue-nudge",
  "week-rail",
  "revenue-lines",
  "cost-lines",
  "also-tracked",
  "statement",
  "labor-ledger",
  "fold-labor",
  "fold-pnl",
  "purchasing-fold",
  "card-revenue",
  "card-cogs",
  "card-gross_margin",
  "chart",
  "billback",
  "billback-period",
  "billback-ledger",
]);

// Playwright page-side evaluator: returns the figure set after folds open.
// Run inside the browser context — plain DOM only.
// Top-level "block" attrs: what the comparator groups figures under.
// Anything else (pill, hero-cogs, card-actual, etc.) is a SUB-landmark
// used for row/column naming.
const TOP_BLOCKS = [
  "cards-row",
  "card-revenue",
  "card-cogs",
  "card-gross_margin",
  "status-line",
  "settling-strip",
  "overdue-nudge",
  "week-rail",
  "revenue-lines",
  "cost-lines",
  "also-tracked",
  "statement",
  "pnl-table",
  "labor-ledger",
  "fold-labor",
  "fold-pnl",
  "fold-billback",
  "chart",
  "chart-fold",
  "billback",
  "billback-period",
  "billback-ledger",
  "cp-vsproj",
];
const EXTRACT_FN = `
(() => {
  const TOP_BLOCKS = new Set(${JSON.stringify(TOP_BLOCKS)});
  function normalize(t) {
    return (t || "").replace(/\\s+/g, " ").trim();
  }
  function findBlock(el) {
    let cur = el;
    let fallback = null;
    while (cur && cur !== document.body) {
      const k = cur.getAttribute && cur.getAttribute("data-kpi-ov");
      if (k) {
        if (TOP_BLOCKS.has(k)) return k;
        if (!fallback) fallback = k;
      }
      cur = cur.parentElement;
    }
    return fallback;
  }
  function closestRowLabel(el) {
    // Walk up to find a tr; take its first td/th text.
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === "TR") {
        const first = cur.querySelector("th,td");
        if (first) return normalize(first.textContent);
      }
      cur = cur.parentElement;
    }
    // Otherwise look for a label-ish ancestor.
    cur = el;
    while (cur && cur !== document.body) {
      const kind = cur.getAttribute && cur.getAttribute("data-kpi-ov");
      if (kind && (kind.startsWith("card-") || kind.endsWith("-row"))) {
        const label = cur.querySelector("[data-kpi-ov='card-hdr'],.kpi-ov-card-hdr,.kpi-ov-pair-k,.kpi-ov-cl-k");
        if (label) return normalize(label.textContent);
      }
      cur = cur.parentElement;
    }
    return "";
  }
  function closestColLabel(el) {
    // For table cells, find the header cell in the same column.
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === "TD" || cur.tagName === "TH") {
        const tr = cur.closest("tr");
        if (!tr) break;
        const table = tr.closest("table");
        if (!table) break;
        const idx = Array.from(tr.children).indexOf(cur);
        const headRow = table.querySelector("thead tr") || table.querySelector("tr");
        if (headRow && headRow.children[idx]) {
          return normalize(headRow.children[idx].textContent);
        }
        return "";
      }
      cur = cur.parentElement;
    }
    // For non-table cells, use the data-kpi-ov attribute of the element
    // itself (e.g. "hero-cogs", "card-reference").
    const own = el.getAttribute && el.getAttribute("data-kpi-ov");
    return own || "";
  }
  function toneClass(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const cl = cur.className;
      if (typeof cl === "string") {
        if (/\\bkpi-ov-good\\b|\\bkpi-ov-tone-good\\b/.test(cl)) return "good";
        if (/\\bkpi-ov-bad\\b|\\bkpi-ov-tone-bad\\b/.test(cl)) return "bad";
        if (/\\bkpi-ov-neu\\b|\\bkpi-ov-even\\b|\\bkpi-ov-tone-neutral\\b/.test(cl)) return "neutral";
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // Patterns that count as a figure.
  const patterns = [
    /^\\$-?[\\d,]+(?:\\.\\d+)?(?: credit)?$/,
    /^-?\\d+(?:\\.\\d+)?\\s*%$/,
    /^-?\\d+(?:,\\d{3})*(?:\\.\\d+)?\\s*(?:hrs?|h)$/i,
    /^on budget$/i,
    /^on target$/i,
    /^(?:over|under|above|below|ahead|behind)\\s+(?:budget|target|projection)$/i,
    /^\\d+\\s+days? ago$/i,
    /^\\d+\\s+(?:person|people)$/i,
    /^P\\d+\\s+awaiting verification/i,
  ];
  function looksLikeFigure(t) {
    const s = t.trim();
    if (!s) return false;
    for (const p of patterns) if (p.test(s)) return true;
    return false;
  }

  // Walk ALL leaf text nodes under the board, keep those matching a figure.
  const board = document.querySelector("[data-kpi-ov='board']") || document.body;
  const figures = [];
  const walker = document.createTreeWalker(board, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
    if (!text) continue;
    if (!looksLikeFigure(text)) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    // Hidden check
    if (parent.offsetParent === null && getComputedStyle(parent).position !== "fixed") continue;
    const block = findBlock(parent);
    if (!block) continue;
    const row = closestRowLabel(parent);
    const col = closestColLabel(parent);
    const tone = toneClass(parent);
    figures.push({
      block,
      row_label: row || "",
      column_label: col || "",
      text,
      tone: tone || null,
    });
  }
  // Plain-text dump of visible body for human reference.
  let plain = "";
  try { plain = document.body.innerText || ""; } catch { plain = ""; }
  return { figures, plain };
})()
`;

async function openAllFolds(page) {
  // Try role=button name=/full/i for P&L full toggle, text matches for
  // the four folds. All are best-effort — their absence does not crash
  // the capture; the figure list is what counts.
  const candidates = [
    { sel: "[data-kpi-ov='fold-pnl'] button", name: /full/i },
    { sel: "[data-kpi-ov='fold-pnl']", name: /full|summary|open|p&l|p & l/i },
    { sel: "[data-kpi-ov='fold-labor']", name: /labor|fold/i },
    { sel: "[data-kpi-ov='labor-ledger']", name: /labor|fold/i },
    { sel: "[data-kpi-ov='fold-billback']", name: /bill/i },
    { sel: "[data-kpi-ov='billback-ledger']", name: /bill/i },
  ];
  for (const c of candidates) {
    try {
      const h = await page.$(c.sel);
      if (!h) continue;
      // Click the element; if it isn't a button, click the first button
      // descendant.
      const tag = await h.evaluate((el) => el.tagName);
      if (tag === "BUTTON") {
        await h.click({ timeout: 2000 }).catch(() => {});
      } else {
        const btn = await h.$("button, [role=button], summary");
        if (btn) await btn.click({ timeout: 2000 }).catch(() => {});
      }
    } catch {}
  }
  // Purchasing folds — two variants, click both if present.
  try {
    const folds = await page.$$("[data-kpi-ov='purchasing-fold']");
    for (const f of folds) {
      const btn = await f.$("button, [role=button], summary");
      if (btn) await btn.click({ timeout: 2000 }).catch(() => {});
    }
  } catch {}
  // Any element with data-kpi-ov-open="0" — try clicking its first descendant button.
  try {
    const closed = await page.$$("[data-kpi-ov-open='0']");
    for (const el of closed) {
      const btn = await el.$("button, [role=button], summary");
      if (btn) await btn.click({ timeout: 2000 }).catch(() => {});
    }
  } catch {}
  // Click "Full" dense toggle inside the P&L fold (renders CoG sub-lines
  // + inactive lines + the Also-tracked band).
  try {
    const fullBtn = await page.$("[data-kpi-ov='dense-full']");
    if (fullBtn) await fullBtn.click({ timeout: 2000 }).catch(() => {});
  } catch {}
  // Open per-week accordions inside labor if any (best-effort).
  try {
    const weekToggles = await page.$$(
      ".kpi-ov-labor-week-toggle, [data-kpi-ov='labor-week-toggle']",
    );
    for (const t of weekToggles) {
      await t.click({ timeout: 1000 }).catch(() => {});
    }
  } catch {}
  // 2026-11-20 shape-fix.  LaborLedger fold's WeekTable is
  // deliberately captured with its period bands COLLAPSED, i.e.
  // only the band + grand-total rows render.  The v2 model
  // (laborLedger.ts) carries the per-week + per-worker extended
  // shape under `weeks` + `worker_rows`; the projector in
  // screen_compare only emits band + grand figures to match the
  // DOM at this grain.  An earlier revision of this file tried to
  // click `button.kpi-tbl-bandbtn[aria-expanded='false']` after
  // the fold-open sweep so the DOM would carry every per-week
  // row too, but that interaction caused the labor-ledger fold
  // itself to close on at least S1__CIN_AZ__sal1 (figs went from
  // 160 to 154, labor section vanished from the plain-text dump).
  // The closed-band grain is sufficient: band + grand carry
  // every per-pay-type figure the DOM renders at this scope, and
  // the extended model is still verified by the made-up tests in
  // screen-models.test.mjs.
  //
  // We wait explicitly for the labor + purchasing loaders to drop
  // (aria=status "Loading labor detail…" / "Loading purchasing
  // detail…"), with a generous outer timeout, because the labor
  // route derive can take 4-8s on a first-of-FY sync.  Without
  // this, an earlier render of this probe captured `Loading…`
  // placeholder states and emitted 0 labor figures.
  try {
    await page.waitForFunction(
      () => {
        const loaders = document.querySelectorAll(
          "[data-kpi-ov='labor-ledger-loading'], [data-kpi-ov='labor-fold-loading']",
        );
        return loaders.length === 0;
      },
      { timeout: 20000 },
    );
  } catch {}
  await page.waitForTimeout(500);
}

async function capturePage(page, c, port) {
  const url = `http://localhost:${port}/kpi/overview?${qs(c.url_params)}`;
  const seenPayloads = { routes: [] };
  const responseHandler = async (resp) => {
    try {
      const u = resp.url();
      const urlObj = new URL(u);
      if (!urlObj.pathname.startsWith("/api/kpi/")) return;
      const status = resp.status();
      let body = null;
      try {
        const ct = resp.headers()["content-type"] || "";
        if (/json/.test(ct)) body = await resp.json();
        else body = await resp.text();
      } catch (e) {
        body = { _parse_error: String(e?.message || e) };
      }
      seenPayloads.routes.push({
        pathname: urlObj.pathname,
        query: urlObj.search,
        status,
        body,
      });
    } catch {}
  };
  page.on("response", responseHandler);

  let locked = false;
  let httpStatus = null;
  let errorSnippet = null;

  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    httpStatus = resp ? resp.status() : null;
  } catch (e) {
    errorSnippet = String(e?.message || e).slice(0, 400);
  }

  // Wait up to 60s for the board to render or for an error state.
  const boardSel =
    "[data-kpi-ov='board'], [data-kpi-ov='cards-row'], [data-kpi-ov='status-line'], .kpi-ov-cards, .kpi-ov-cp-table";
  const errSel = ".kpi-state-locked, [data-locked], .kpi-state-error, .kpi-loader";

  // Wait for loader to disappear OR a board landmark to appear.
  try {
    await page.waitForFunction(
      () => {
        const loaders = document.querySelectorAll(".kpi-loader");
        const hasBoard =
          document.querySelector("[data-kpi-ov='board']") ||
          document.querySelector(".kpi-ov-cards") ||
          document.querySelector(".kpi-ov-cp-v");
        const locked = document.querySelector(
          ".kpi-state-locked, [data-locked]",
        );
        const err = document.querySelector(".kpi-state-error");
        if (locked || err) return true;
        if (loaders.length === 0 && hasBoard) return true;
        return false;
      },
      { timeout: 60000 },
    );
  } catch {
    errorSnippet =
      (errorSnippet || "") + " timeout waiting for board/error state";
  }

  // Detect locked / error.
  try {
    locked =
      (await page.$(".kpi-state-locked, [data-locked]")) !== null;
  } catch {}

  if (!locked) {
    // Settle, then open every fold.
    await page.waitForTimeout(800);
    await openAllFolds(page);
    await page.waitForTimeout(800);
  }

  let figures = [];
  let plain = "";
  try {
    const extracted = await page.evaluate(EXTRACT_FN);
    figures = extracted.figures || [];
    plain = extracted.plain || "";
  } catch (e) {
    errorSnippet =
      (errorSnippet || "") + " extract_err=" + String(e?.message || e);
  }

  page.off("response", responseHandler);

  // Drain remaining in-flight responses.
  await page.waitForTimeout(300);

  return {
    url,
    http_status: httpStatus,
    locked,
    error_snippet: errorSnippet,
    payloads: seenPayloads.routes,
    figures,
    plain,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  const { cases: allCases, lvp, today, fytdEnd } = await buildCases();
  // Optional --limit=N for smoke runs.
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;
  // Optional --filter=<substr> to restrict case_id.
  const filterArg = process.argv.find((a) => a.startsWith("--filter="));
  const filter = filterArg ? filterArg.slice("--filter=".length) : null;
  let cases = allCases;
  if (filter) cases = cases.filter((c) => c.case_id.includes(filter));
  if (limit) cases = cases.slice(0, limit);
  log(`built ${cases.length} cases (of ${allCases.length} total)`);
  // Persist the case list so compare can replay the same set. Only
  // overwrite when the full battery is running (no filter / no limit);
  // partial runs must not clobber the full-run case index.
  if (!filter && !limit) {
    fs.writeFileSync(
      path.join(OUT_ROOT, "cases.json"),
      JSON.stringify(
        { built_at: new Date().toISOString(), lvp, today, fytdEnd, cases: allCases },
        null,
        2,
      ),
    );
  }

  const port = await pickFreePort();
  const child = await spawnDevServer(port);

  const playwright = await import(V1_READONLY_PLAYWRIGHT);
  const chromium = playwright.chromium;

  const browser = await chromium.launch({
    headless: true,
  });
  log("chromium launched");

  const perCaseStatus = [];

  try {
    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      const ctx = await browser.newContext({
        viewport: { width: 1520, height: 1100 },
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(60000);

      let result = null;
      try {
        result = await capturePage(page, c, port);
      } catch (e) {
        result = {
          url: `http://localhost:${port}/kpi/overview?${qs(c.url_params)}`,
          http_status: null,
          locked: false,
          error_snippet: String(e?.message || e).slice(0, 400),
          payloads: [],
          figures: [],
          plain: "",
        };
      }

      // Write payloads.
      fs.writeFileSync(
        path.join(OUT_PAYLOADS, `${c.case_id}.json`),
        JSON.stringify(
          {
            case: c,
            url: result.url,
            http_status: result.http_status,
            payloads: result.payloads,
          },
          null,
          2,
        ),
      );
      // Write screens.
      fs.writeFileSync(
        path.join(OUT_SCREENS, `${c.case_id}.json`),
        JSON.stringify(
          {
            case: c,
            url: result.url,
            http_status: result.http_status,
            locked: result.locked,
            error_snippet: result.error_snippet,
            figures: result.figures,
          },
          null,
          2,
        ),
      );
      // Write screens-text (plain).
      fs.writeFileSync(
        path.join(OUT_SCREENS_TXT, `${c.case_id}.txt`),
        result.plain || "",
      );

      perCaseStatus.push({
        case_id: c.case_id,
        group: c.group,
        locked: result.locked,
        http_status: result.http_status,
        figures_count: result.figures.length,
        api_calls: result.payloads.length,
        error: result.error_snippet || null,
      });

      log(
        `[${i + 1}/${cases.length}] ${c.case_id}`,
        `locked=${result.locked}`,
        `figs=${result.figures.length}`,
        `apis=${result.payloads.length}`,
        result.error_snippet ? `err=${result.error_snippet.slice(0, 80)}` : "",
      );

      await ctx.close();
    }
  } finally {
    await browser.close();
    killDevServer(child);
  }

  // Merge into capture_status.json (so partial reruns update that file
  // without clobbering the prior full-battery status for the OTHER cases).
  let existing = [];
  try {
    const p = path.join(OUT_ROOT, "capture_status.json");
    if (fs.existsSync(p)) existing = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  const byId = new Map(existing.map((r) => [r.case_id, r]));
  for (const r of perCaseStatus) byId.set(r.case_id, r);
  fs.writeFileSync(
    path.join(OUT_ROOT, "capture_status.json"),
    JSON.stringify([...byId.values()], null, 2),
  );

  log(`done; wrote ${perCaseStatus.length} cases.`);
}

main().catch((e) => {
  console.error("[capture] FATAL", e);
  process.exit(1);
});
