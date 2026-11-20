#!/usr/bin/env node
// WARNING: THIS SCRIPT WRITES TO THE LIVE READER-NOTES TABLE when
// run with `--keyboard-only <probeRowId>` (the keyboard walk
// drives the owner action route end-to-end against the probe row
// the orchestrator created). The read-only modes (no flag, or
// `--read-only`) do not write. Do not run with `--keyboard-only`
// without the owner's say.
/**
 * L4b end-to-end evidence, Playwright headless chromium against
 * a local prod build on :3200. Prints:
 *   A5   the battery - sweeps the owner's three lists + the decline
 *        step + /mine at 360..1920 step 40; reports hScroll, under-
 *        48 controls, type-size count, clipped text, console errors.
 *   A6   the keyboard walks - Accept, Decline with a reason, Put
 *        back to Open - with the real key-press count.
 *   A7   the mailto href shape for one note, with the sender's
 *        email masked in the printed output.
 *
 * No writes. Opens the live owner page as the owner and reads what
 * is on screen; the three live rows (two June notes + one from
 * 2026-11-20, all open) are the canvas the battery walks over.
 */

import { chromium } from "/tmp/pw-tmp/node_modules/playwright/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.KF_DEV_BASE || "http://localhost:3200";
const SHOTS_DIR = "/tmp/kf-v2-library-l4b-shots";
mkdirSync(SHOTS_DIR, { recursive: true });

function ownerEmail() {
  const raw = process.env.OWNER_EMAILS || "";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)[0];
}

async function sign(context) {
  const email = ownerEmail();
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const resp = await fetch(data.properties.action_link, { redirect: "manual" });
  const loc = resp.headers.get("location");
  const hash = new URLSearchParams(loc.slice(loc.indexOf("#") + 1));
  const jar = [];
  const sc = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: { getAll: () => [], setAll: (l) => { for (const c of l) jar.push(c); } } },
  );
  await sc.auth.setSession({
    access_token: hash.get("access_token"),
    refresh_token: hash.get("refresh_token"),
  });
  await context.addCookies(jar.map((c) => ({
    name: c.name, value: c.value, domain: new URL(BASE).hostname, path: c.options.path || "/",
    httpOnly: c.options.httpOnly ?? false, secure: c.options.secure ?? false,
    sameSite: "Lax",
    expires: c.options.maxAge ? Math.floor(Date.now() / 1000) + c.options.maxAge : -1,
  })));
}

// Battery measurement reused from L3.
const DISTINCT_FONT_SIZES_SELECTOR =
  ".kf-lb-sugs *:not(script):not(style),.kf-lb-sugs-tab,.kf-lb-sug-row *,.kf-lb-doc *";

async function measureBattery(page) {
  return await page.evaluate((sel) => {
    const hScroll =
      document.documentElement.scrollWidth > document.documentElement.clientWidth;
    let underFloor = 0;
    const offenders = [];
    document.querySelectorAll("button,a,input,select,textarea").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return;
      if (el.type === "checkbox") return;
      if (r.height < 48) {
        underFloor += 1;
        if (offenders.length < 3) {
          offenders.push(
            `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 40)}=${Math.round(r.height)}`,
          );
        }
      }
    });
    const sizes = new Set();
    document.querySelectorAll(sel).forEach((el) => {
      const cs = getComputedStyle(el);
      const t = (el.textContent || "").trim();
      if (!t) return;
      const fs = Math.round(parseFloat(cs.fontSize || "0"));
      if (fs > 0) sizes.add(fs);
    });
    let clipped = 0;
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.textContent || "").trim();
      if (!t) return;
      if (el.childElementCount > 0) return;
      const cs = getComputedStyle(el);
      if (cs.position === "absolute" &&
        (cs.clip === "rect(0px, 0px, 0px, 0px)" ||
          (parseFloat(cs.width) <= 2 && parseFloat(cs.height) <= 2))) return;
      if (el.scrollWidth > el.clientWidth + 1) clipped += 1;
    });
    return { hScroll, underFloor, offenders, sizes: [...sizes].sort((a, b) => a - b), clipped };
  }, DISTINCT_FONT_SIZES_SELECTOR);
}

async function openState(page, state) {
  if (state === "owner-open") {
    await page.goto(`${BASE}/library/suggestions`, { waitUntil: "load" });
  } else if (state === "owner-accepted") {
    await page.goto(`${BASE}/library/suggestions?list=accepted`, { waitUntil: "load" });
  } else if (state === "owner-closed") {
    await page.goto(`${BASE}/library/suggestions?list=closed`, { waitUntil: "load" });
  } else if (state === "decline-open") {
    await page.goto(`${BASE}/library/suggestions`, { waitUntil: "load" });
    // Open the decline step on the first open row (if any).
    await page.evaluate(() => {
      const row = document.querySelector(".kf-lb-sug-row");
      if (!row) return;
      const decline = Array.from(row.querySelectorAll("button")).find(
        (b) => (b.textContent || "").trim() === "Decline",
      );
      if (decline) decline.click();
    });
    await page.waitForSelector(".kf-lb-sug-row__decline", { timeout: 1500 }).catch(() => {});
  } else if (state === "mine") {
    await page.goto(`${BASE}/library/suggestions/mine`, { waitUntil: "load" });
  }
  await page.waitForTimeout(150);
}

async function runBattery(context) {
  const states = ["owner-open", "owner-accepted", "owner-closed", "decline-open", "mine"];
  const widths = [];
  for (let w = 360; w <= 1920; w += 40) widths.push(w);

  const rows = [];
  const consoleErrors = [];
  context.on("page", (p) => {
    p.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push({ at: p.url(), msg: msg.text() }); });
    p.on("pageerror", (err) => consoleErrors.push({ at: p.url(), msg: err.message }));
  });

  for (const state of states) {
    for (const w of widths) {
      let attempts = 0;
      let measured = null;
      while (attempts < 3 && !measured) {
        attempts += 1;
        const page = await context.newPage();
        try {
          await page.setViewportSize({ width: w, height: Math.max(700, Math.min(w + 100, 1000)) });
          await openState(page, state);
          measured = await measureBattery(page);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempts === 3) console.warn(`  ${state}@${w} failed: ${msg.slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, 400));
        }
        try { await page.close(); } catch {}
      }
      rows.push({ state, width: w, ...(measured ?? { failed: true }) });
    }
  }

  console.log("\n# A5 battery sweep (worst-of per state):\n");
  for (const state of states) {
    const rs = rows.filter((r) => r.state === state && !r.failed);
    const total = rows.filter((r) => r.state === state).length;
    const hScrollW = rs.filter((r) => r.hScroll).map((r) => r.width);
    const underW = rs.filter((r) => r.underFloor > 0).map((r) => `${r.width}(${r.underFloor} off=${r.offenders.slice(0, 2).join("|")})`);
    const maxSizes = rs.reduce((m, r) => Math.max(m, (r.sizes || []).length), 0);
    const sizesOverW = rs.filter((r) => (r.sizes || []).length > 5).map((r) => `${r.width}(${r.sizes.length}: ${r.sizes.join(",")})`);
    const clippedW = rs.filter((r) => r.clipped > 0).map((r) => `${r.width}(${r.clipped})`);
    console.log("---", state, `(${rs.length}/${total} measured)`, "---");
    console.log(`  hScroll (widths)      ${hScrollW.length ? hScrollW.join(",") : "-"}`);
    console.log(`  under48 (widths)      ${underW.length ? underW.slice(0, 5).join(", ") : "-"}`);
    console.log(`  max distinct sizes    ${maxSizes}`);
    console.log(`  sizes>5 (width(n:list)) ${sizesOverW.length ? sizesOverW.slice(0, 3).join(", ") : "-"}`);
    console.log(`  clipped text (widths) ${clippedW.length ? clippedW.slice(0, 5).join(", ") : "-"}`);
  }
  console.log(`\nconsole errors seen: ${consoleErrors.length}`);
  if (consoleErrors.length) {
    const seen = new Set();
    for (const e of consoleErrors) {
      const k = e.msg.slice(0, 160);
      if (seen.has(k)) continue;
      seen.add(k);
      console.log("  -", k);
      if (seen.size >= 6) break;
    }
  }
  writeFileSync(`${SHOTS_DIR}/battery.json`, JSON.stringify(rows, null, 2));
  console.log(`\nfull sweep JSON: ${SHOTS_DIR}/battery.json`);
}

async function activeDesc(page) {
  return await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return "null";
    const cls = (el.className || "").toString().slice(0, 60);
    const txt = (el.textContent || "").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}.${cls} text="${txt}"`;
  });
}

// DB verifier shared by every step of the keyboard walk. The
// harness refuses to proceed if the server-side state does not
// match the expected shape; a failure here is proof the UI did
// not do what the keystrokes should have.
async function assertRowState(supaAdmin, id, expectStatus, expectOutcome) {
  const q = await supaAdmin
    .from("document_issues")
    .select("id, status, handled_outcome, handled_note")
    .eq("id", id)
    .maybeSingle();
  if (q.error || !q.data) {
    throw new Error(`assertRowState: could not read id=${id}: ${q.error?.message ?? "no row"}`);
  }
  const row = q.data;
  const ok = row.status === expectStatus && row.handled_outcome === expectOutcome;
  const line = `    assert status=${expectStatus} outcome=${String(expectOutcome)} -> actual status=${row.status} outcome=${String(row.handled_outcome)}: ${ok ? "pass" : "FAIL"}`;
  console.log(line);
  if (!ok) throw new Error(`assertRowState FAIL: expected (${expectStatus}, ${expectOutcome}), got (${row.status}, ${row.handled_outcome})`);
  return row;
}

async function runKeyboardOnId(context, probeId) {
  console.log(`\n# A6 keyboard walk against probe row id=${probeId}\n`);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  // Service-role client to verify state after each action. The
  // key is already in the env the parent script loaded.
  const supaAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Each probe row carries "L4b probe <row-uuid>" in its issue_text
  // so the locator scopes to exactly THIS row even when another
  // probe row from the same run sits on the same list.
  const marker = `L4b probe ${probeId}`;

  async function findProbeRow() {
    // Tag the row that contains the unique marker with a
    // data-kf-probe attribute carrying the probe id, then return
    // a selector keyed on that attribute.
    await page.evaluate(({ needle, mark }) => {
      const rows = Array.from(document.querySelectorAll(".kf-lb-sug-row"));
      for (const row of rows) {
        if ((row.textContent || "").includes(needle)) {
          row.setAttribute("data-kf-probe", mark);
          return;
        }
      }
    }, { needle: marker, mark: probeId });
    return `.kf-lb-sug-row[data-kf-probe="${probeId}"]`;
  }

  async function waitForFocusOff(el) {
    // After Tab, wait for focus to actually leave the current
    // element. Hangs mean a real focus trap - we'd surface that
    // as a product bug via the timeout.
    await page.waitForFunction(
      (prev) => document.activeElement && document.activeElement !== prev,
      el,
      { timeout: 2500 },
    );
  }

  let presses = 0;
  let steps = 0;
  let stepsPass = 0;

  async function step(name, fn, verifyStatus, verifyOutcome) {
    steps += 1;
    console.log(`  --- step ${steps}: ${name} ---`);
    const nBefore = presses;
    try {
      await fn();
    } catch (err) {
      console.log(`  FAIL (${name}): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    console.log(`    key presses this step: ${presses - nBefore}  (running total: ${presses})`);
    // Settle in case the fetch completed just after the click.
    await page.waitForTimeout(400);
    await assertRowState(supaAdmin, probeId, verifyStatus, verifyOutcome);
    stepsPass += 1;
  }

  // ======================================================================
  // STEP 1 - Accept
  // ======================================================================
  await step(
    "Accept via Enter on the probe row's Accept button",
    async () => {
      await page.goto(`${BASE}/library/suggestions`, { waitUntil: "load" });
      await page.waitForTimeout(300);
      const sel = await findProbeRow();
      const handle = await page.$(sel);
      if (!handle) throw new Error("probe row not found on Open list");
      const acceptBtn = await page.locator(`${sel} .kf-btn--primary`).first();
      await acceptBtn.focus();
      const before = await page.evaluateHandle(() => document.activeElement);
      console.log(`    focus-before: ${await activeDesc(page)}`);
      await page.keyboard.press("Enter");
      presses += 1;
      // After Enter, the row moves out of the Open list (optimistic
      // update); wait for either focus to leave the Accept button
      // (the button vanishes with the row) or the fetch to land.
      await page.waitForFunction(
        (prev) => !document.body.contains(prev),
        before,
        { timeout: 2500 },
      );
    },
    "in_progress",
    "used",
  );

  // ======================================================================
  // STEP 2 - Decline with a reason
  // ======================================================================
  await step(
    "Decline-with-reason: open step, type, Tab, Enter",
    async () => {
      await page.goto(`${BASE}/library/suggestions?list=accepted`, { waitUntil: "load" });
      await page.waitForTimeout(300);
      const sel = await findProbeRow();
      const handle = await page.$(sel);
      if (!handle) throw new Error("probe row not found on Accepted list");
      const declineBtn = await page.locator(`${sel} .kf-lb-sug-row__acts button`, { hasText: "Decline" }).first();
      await declineBtn.focus();
      console.log(`    focus-before Decline: ${await activeDesc(page)}`);
      await page.keyboard.press("Enter");
      presses += 1;
      await page.waitForSelector(`${sel} .kf-lb-sug-row__decline`, { timeout: 2000 });
      // The row component auto-focuses the reason textarea 20ms
      // after mounting the decline step; wait until that lands
      // so the type-then-Tab chain starts from a known focus.
      await page.waitForFunction(
        (rowSel) => {
          const row = document.querySelector(rowSel);
          const ta = row ? row.querySelector("textarea") : null;
          return !!ta && document.activeElement === ta;
        },
        sel,
        { timeout: 2000 },
      );
      console.log(`    focus-after decline-step mount: ${await activeDesc(page)}`);

      // Type a short reason. Each char is a key press.
      const reason = `A6 probe ${probeId.slice(0, 8)} - plain text only.`;
      await page.keyboard.type(reason);
      presses += reason.length;
      // Let React settle after the last onChange.
      await page.waitForTimeout(150);

      // Capture the textarea element before Tab so we can wait
      // for focus to actually leave it.
      const taHandle = await page.evaluateHandle((rowSel) => {
        return document.querySelector(`${rowSel} textarea`);
      }, sel);
      await page.keyboard.press("Tab");
      presses += 1;
      await waitForFocusOff(taHandle);
      const afterTabDesc = await activeDesc(page);
      console.log(`    focus-after Tab from textarea: ${afterTabDesc}`);
      // Assert the focus landed on the Decline-this-note button.
      const onDeclineNote = await page.evaluate((rowSel) => {
        const btn = document.activeElement;
        if (!btn || !(btn instanceof HTMLButtonElement)) return false;
        const row = document.querySelector(rowSel);
        if (!row || !row.contains(btn)) return false;
        return (btn.textContent || "").trim() === "Decline this note";
      }, sel);
      if (!onDeclineNote) {
        throw new Error("Tab from the reason textarea did not land on the Decline-this-note button. If this reproduces in a real browser, it is a product bug.");
      }
      await page.keyboard.press("Enter");
      presses += 1;
    },
    "closed",
    "no_change",
  );

  // Also assert the handled_note is the reason we typed.
  {
    const q = await supaAdmin
      .from("document_issues")
      .select("handled_note")
      .eq("id", probeId)
      .maybeSingle();
    const note = (q.data && q.data.handled_note) || "";
    const ok = typeof note === "string" && note.startsWith("A6 probe ");
    console.log(`    assert handled_note stored and starts with "A6 probe ": ${ok ? "pass" : "FAIL"}`);
    if (!ok) throw new Error("handled_note was not stored");
  }

  // ======================================================================
  // STEP 3 - Put back to Open
  // ======================================================================
  await step(
    "Put back to Open via Enter on the probe row's Reopen button",
    async () => {
      await page.goto(`${BASE}/library/suggestions?list=closed`, { waitUntil: "load" });
      await page.waitForTimeout(300);
      const sel = await findProbeRow();
      const handle = await page.$(sel);
      if (!handle) throw new Error("probe row not found on Closed list");
      const reopen = await page.locator(`${sel} .kf-lb-sug-row__acts button`, { hasText: "Put back to Open" }).first();
      await reopen.focus();
      console.log(`    focus-before Put-back: ${await activeDesc(page)}`);
      const before = await page.evaluateHandle(() => document.activeElement);
      await page.keyboard.press("Enter");
      presses += 1;
      // After Enter, the row vanishes from Closed (optimistic
      // update) OR the fetch lands and the status flips in the DB.
      // Wait for whichever happens first.
      await page.waitForFunction(
        (prev) => !document.body.contains(prev),
        before,
        { timeout: 2500 },
      );
    },
    "open",
    null,
  );

  console.log(`\n  steps pass ${stepsPass}/${steps}; total key presses: ${presses}`);
  if (stepsPass !== steps) {
    throw new Error(`A6 FAIL: ${steps - stepsPass} of ${steps} steps did not pass`);
  }
  await page.close();
}

async function runMailto(context) {
  console.log("\n# A7 mailto href shape (for one note, sender masked)\n");
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/library/suggestions`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  const href = await page.$eval(
    ".kf-lb-sug-row__acts a[href^='mailto:']",
    (el) => el.getAttribute("href"),
  ).catch(() => null);
  if (!href) {
    console.log("  (no mailto link on the first open row; skipped)");
    await page.close();
    return;
  }
  // Mask the sender address, the document title (anywhere in the
  // subject/body), and the reader-quoted note. This probe only
  // reports the SHAPE of the href. The repo is public; the real
  // values live in the live table and must not cross into the log.
  // The subject looks like "Your note on <id> - <title>" and the
  // body carries "About <id> (<title>)" plus the quoted note; we
  // keep the doc number and the fixed words, replace everything
  // else with placeholders.
  let masked = href.replace(/mailto:[^?]+/, "mailto:<sender>");
  // Extract the id so we can keep the SHAPE honest without leaking.
  const idMatch = /About%20([A-Z]{2,6}-\d{3}(?:-[A-Z]{2,4})?)/.exec(masked);
  const id = idMatch ? idMatch[1] : "<id>";
  // Subject: "Your note on <id> - <title>" -> "<id> - <title>"
  masked = masked.replace(
    /subject=Your%20note%20on%20[^&]+/,
    `subject=Your%20note%20on%20${id}%20-%20%3Ctitle%3E`,
  );
  // Body: "About <id> (<title>)\n\nYou wrote:\n> <text>" ->
  //       "About <id> (<title>)\n\nYou wrote:\n> <text>"
  masked = masked.replace(
    /body=About%20[^(]*\([^)]*\)[^Y]*You%20wrote%3A%0A[^$]*/,
    `body=About%20${id}%20%28%3Ctitle%3E%29%0A%0AYou%20wrote%3A%0A%3E%20%3Ctext%3E%0A%0A`,
  );
  console.log(`  ${masked}`);
  console.log(`  (the href has mailto:<sender>, subject= with the doc id + a title placeholder, body= with the quoted note placeholder)`);
  await page.close();
}

async function main() {
  const args = process.argv.slice(2);
  const readOnly = args.length === 0 || args.includes("--read-only");
  const keyboardOnlyIdx = args.indexOf("--keyboard-only");
  const keyboardOnlyId = keyboardOnlyIdx >= 0 ? args[keyboardOnlyIdx + 1] : null;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  console.log(`sign in as ${ownerEmail()}...`);
  await sign(context);
  if (keyboardOnlyId) {
    // Scoped keyboard walk - the orchestrator creates the probe
    // row and passes its id; we only move THAT row through the
    // state machine and leave everything else alone.
    await runKeyboardOnId(context, keyboardOnlyId);
  } else if (readOnly) {
    await runMailto(context);
    await runBattery(context);
    console.log("\n# A6 keyboard walk - SKIPPED (writes to live DB; re-run under the owner's say).\n");
  } else {
    await runMailto(context);
    await runBattery(context);
    console.log("\nPass --keyboard-only <probeRowId> to walk the keyboard case against a probe row.\n");
  }
  await context.close();
  await browser.close();
  console.log("\ndone.");
}

main().catch((e) => {
  console.error("e2e failed:", e?.stack || String(e));
  process.exit(1);
});
