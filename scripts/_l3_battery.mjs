#!/usr/bin/env node
/**
 * Library L3 battery. Playwright, against a local build on :3100.
 * Mirrors _l2_battery.mjs's shape; see that file for the sign-in
 * approach (admin generateLink + @supabase/ssr setSession cookies).
 *
 * Six states per width:
 *   doc-top         - /library/<docId> at the top
 *   doc-end         - /library/<docId> scrolled to the end footer
 *   details         - Details panel open on /library/<docId>
 *   share           - Share panel open on /library/<docId>
 *   suggest         - Suggest-an-edit panel open on /library/<docId>
 *   suggestions     - /library/suggestions (owner page)
 *
 * The doc id used for the sweep is $KF_L3_DOC_ID or (fallback) the
 * first unrestricted doc with at least three Live sections.
 *
 * Screenshots:
 *   390/820/1280/1440 of doc-top, share, suggest. Saved outside the
 *   repo. The repo is public, so tile text (doc title, card line,
 *   id) is blurred before capture.
 */

import { chromium } from "/tmp/pw-tmp/node_modules/playwright/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.KF_DEV_BASE || "http://localhost:3100";
const SHOTS_DIR = "/tmp/kf-v2-library-l3-shots";
mkdirSync(SHOTS_DIR, { recursive: true });

function ownerEmail() {
  const raw = process.env.OWNER_EMAILS || "";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)[0];
}

async function sessionTokensForOwner(email) {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error) throw new Error(`magiclink: ${error.message}`);
  const link = data?.properties?.action_link;
  if (!link) throw new Error("no action_link on generateLink response");
  const resp = await fetch(link, { redirect: "manual" });
  const loc = resp.headers.get("location");
  if (!loc) throw new Error("no redirect from verify");
  const hashIndex = loc.indexOf("#");
  if (hashIndex < 0) throw new Error("no session hash on redirect");
  const hash = new URLSearchParams(loc.slice(hashIndex + 1));
  const access_token = hash.get("access_token");
  const refresh_token = hash.get("refresh_token");
  if (!access_token || !refresh_token) throw new Error("tokens missing");
  return { access_token, refresh_token };
}

async function signInInBrowser(context, email) {
  const { access_token, refresh_token } = await sessionTokensForOwner(email);
  const jar = [];
  const serverClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => [],
        setAll: (list) => {
          for (const { name, value, options } of list) {
            jar.push({ name, value, options: options ?? {} });
          }
        },
      },
    },
  );
  const { error } = await serverClient.auth.setSession({
    access_token,
    refresh_token,
  });
  if (error) throw new Error(`setSession: ${error.message}`);
  const baseUrl = new URL(BASE);
  const playwrightCookies = jar.map((c) => ({
    name: c.name,
    value: c.value,
    domain: baseUrl.hostname,
    path: c.options.path || "/",
    httpOnly: c.options.httpOnly ?? false,
    secure: c.options.secure ?? false,
    sameSite: (c.options.sameSite ?? "Lax").charAt(0).toUpperCase() + (c.options.sameSite ?? "ax").slice(1),
    expires: c.options.maxAge ? Math.floor(Date.now() / 1000) + c.options.maxAge : -1,
  }));
  await context.addCookies(playwrightCookies);
  return { ok: true, count: playwrightCookies.length };
}

// Font size + contrast measurements reused from L2.
const DISTINCT_FONT_SIZES_SELECTOR =
  ".kf-lb-doc__art h1,.kf-lb-doc__art h2,.kf-lb-doc__art h3,.kf-lb-doc__art p,.kf-lb-doc__art li,.kf-lb-doc__art dd,.kf-lb-doc__art dt,.kf-lb-doc__art strong,.kf-docbody h1,.kf-docbody h2,.kf-docbody h3,.kf-docbody p,.kf-docbody li,.kf-docbody td,.kf-docbody th,.kf-lb-doc__lede,.kf-lb-doc__title";

async function measureBattery(page) {
  return await page.evaluate((sel) => {
    const hScroll =
      document.documentElement.scrollWidth > document.documentElement.clientWidth;
    let underFloor = 0;
    const offenders = [];
    document.querySelectorAll("button,a,input,select").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return;
      // Skip the file-input-like checkbox (visible as a 20x20 tick
      // inside the Share panel; screen reader name is the surrounding
      // label).
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

async function pickDocId(context) {
  // Fast path: env var set the doc we want.
  if (process.env.KF_L3_DOC_ID) return process.env.KF_L3_DOC_ID;
  // Fetch /api/academy/library through the signed-in context so L1's
  // rule has already pruned the list to readable docs.
  const probe = await context.newPage();
  const resp = await probe.goto(`${BASE}/api/academy/library`, { waitUntil: "load" });
  if (!resp || resp.status() !== 200) {
    await probe.close();
    return "POL-001"; // fallback, caller should set KF_L3_DOC_ID
  }
  const j = await resp.json();
  // The library payload has .shelves[].docs[]. Pick the first doc on
  // the first non-empty shelf with a "POL" or "SOP" prefix; those
  // tend to have several h1 sections.
  const docs = [];
  for (const s of j?.shelves ?? []) {
    for (const d of s?.docs ?? []) docs.push(d);
  }
  await probe.close();
  const pref = docs.find((d) => /^(POL|SOP)-/.test(d.id)) || docs[0];
  return pref?.id || "POL-001";
}

async function openPanel(page, docUrl, btnSel, panelSel) {
  await page.goto(docUrl, { waitUntil: "load" });
  // Wait for DocControlsIsland to hydrate + register its listener.
  await page.waitForSelector("[data-lb-doc-ready='1']", { timeout: 3000 });
  // The button must be visible for the control to be openable at
  // this width. When it is hidden by CSS (Details is `display:none`
  // below 1024 by design, Print below 1024 too), Playwright's click
  // waits for visibility and would time out; we detect the hidden
  // case explicitly and treat it as "panel not applicable at this
  // width" rather than a failure.
  const visible = await page.$eval(btnSel, (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  }).catch(() => false);
  if (!visible) {
    // Caller gets a {skipped:true} measurement for this cell; the
    // sweep summary labels it as "control hidden by design at this
    // width" rather than a failure.
    return { skipped: true, reason: "control-hidden" };
  }
  await page.click(btnSel, { timeout: 2000 });
  await page.waitForSelector(panelSel, { timeout: 2000 });
  return { skipped: false };
}

async function openState(page, state, docId) {
  const docUrl = `${BASE}/library/${encodeURIComponent(docId)}`;
  if (state === "doc-top") {
    await page.goto(docUrl, { waitUntil: "load" });
  } else if (state === "doc-end") {
    await page.goto(docUrl, { waitUntil: "load" });
    await page.evaluate(() => {
      const f = document.querySelector(".kf-lb-end");
      f?.scrollIntoView({ block: "start" });
    });
  } else if (state === "details") {
    const r = await openPanel(page, docUrl, ".kf-lb-ta--details", ".kf-lb-panel--details");
    if (r.skipped) return r;
  } else if (state === "share") {
    const r = await openPanel(page, docUrl, ".kf-lb-ta--share", ".kf-lb-panel--share");
    if (r.skipped) return r;
  } else if (state === "suggest") {
    const r = await openPanel(page, docUrl, ".kf-lb-ta--sug", ".kf-lb-panel--suggest");
    if (r.skipped) return r;
  } else if (state === "suggestions") {
    await page.goto(`${BASE}/library/suggestions`, { waitUntil: "load" });
  }
  await page.waitForTimeout(150);
  return { skipped: false };
}

async function main() {
  const email = ownerEmail();
  if (!email) throw new Error("OWNER_EMAILS is empty");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 900 },
  });
  const consoleErrors = [];
  context.on("page", (p) => {
    p.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push({ at: p.url(), msg: msg.text() });
    });
    p.on("pageerror", (err) => {
      consoleErrors.push({ at: p.url(), msg: err.message });
    });
  });
  console.log(`sign in as ${email}...`);
  const ok = await signInInBrowser(context, email);
  console.log("  setSession:", ok);
  const docId = await pickDocId(context);
  console.log("  doc under test:", docId);

  // Sanity.
  const probe = await context.newPage();
  const resp = await probe.goto(`${BASE}/library/${docId}`, { waitUntil: "load" });
  console.log(`probe /library/${docId} status:`, resp?.status());
  console.log("probe url after nav:", probe.url());
  await probe.close();

  const widths = [];
  for (let w = 360; w <= 1920; w += 40) widths.push(w);
  const states = ["doc-top", "doc-end", "details", "share", "suggest", "suggestions"];
  const rows = [];
  for (const state of states) {
    for (const w of widths) {
      let attempts = 0;
      let measured = null;
      let skipped = false;
      while (attempts < 3 && !measured && !skipped) {
        attempts += 1;
        const page = await context.newPage();
        try {
          await page.setViewportSize({ width: w, height: Math.max(700, Math.min(w + 100, 1000)) });
          const r = await openState(page, state, docId);
          if (r && r.skipped) {
            skipped = true;
          } else {
            measured = await measureBattery(page);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempts === 3) {
            console.warn(`  ${state}@${w} failed after 3 tries: ${msg.slice(0, 80)}`);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        try { await page.close(); } catch {}
      }
      rows.push({ state, width: w, ...(measured ?? (skipped ? { hScroll: null, underFloor: null, offenders: [], sizes: [], clipped: null, skipped: true } : { hScroll: null, underFloor: null, offenders: [], sizes: [], clipped: null, failed: true })) });
    }
  }

  // Per-state worst-of.
  console.log("\nA6 - battery sweep (worst-of per state):\n");
  for (const state of states) {
    const rs = rows.filter((r) => r.state === state && !r.failed && !r.skipped);
    const total = rows.filter((r) => r.state === state).length;
    const ok = rs.length;
    const skip = rows.filter((r) => r.state === state && r.skipped).length;
    const hScrollW = rs.filter((r) => r.hScroll).map((r) => r.width);
    const underW = rs.filter((r) => r.underFloor > 0).map((r) => `${r.width}(${r.underFloor} off=${r.offenders.slice(0, 2).join("|")})`);
    const maxSizes = rs.reduce((m, r) => Math.max(m, r.sizes.length), 0);
    const sizesOverW = rs.filter((r) => r.sizes.length > 5).map((r) => `${r.width}(${r.sizes.length}: ${r.sizes.join(",")})`);
    const clippedW = rs.filter((r) => r.clipped > 0).map((r) => `${r.width}(${r.clipped})`);
    console.log("---", state, `(${ok}/${total} widths measured; ${skip} skipped because control is hidden by design at that width)`, "---");
    console.log(`  hScroll (widths)      ${hScrollW.length ? hScrollW.join(",") : "-"}`);
    console.log(`  under48 (widths)      ${underW.length ? underW.slice(0, 5).join(", ") : "-"}`);
    console.log(`  max distinct sizes    ${maxSizes}`);
    console.log(`  sizes>5 (width(n: list)) ${sizesOverW.length ? sizesOverW.slice(0, 4).join(", ") : "-"}`);
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

  // A11 screenshots. The repo is public: we blur the article words
  // and the document title before capture. Icons, layout, chrome
  // survive.
  const BLUR_CSS = `
    .kf-docbody *, .kf-lb-doc__title, .kf-lb-doc__lede,
    .kf-lb-sug-row__title, .kf-lb-panel__kick strong,
    .kf-rail__account, .kf-rail__item span, .kf-topbar__title { filter: blur(5px) !important; }
  `;
  console.log("\nA11 - screenshots:");
  for (const state of ["doc-top", "share", "suggest"]) {
    for (const w of [390, 820, 1280, 1440]) {
      const page = await context.newPage();
      await page.setViewportSize({ width: w, height: Math.max(900, w) });
      try {
        await openState(page, state, docId);
      } catch {
        // Keep going - some states only open above a width threshold.
      }
      await page.addStyleTag({ content: BLUR_CSS });
      await page.waitForTimeout(100);
      const path = `${SHOTS_DIR}/${state}-${w}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log("  ", path);
      await page.close();
    }
  }

  await context.close();
  await browser.close();
  console.log("\ndone.");
}

main().catch((e) => {
  console.error("battery failed:", e?.stack || String(e));
  process.exit(1);
});
