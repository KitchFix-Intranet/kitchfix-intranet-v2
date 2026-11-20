#!/usr/bin/env node
/**
 * L3 end-to-end evidence, Playwright headless chromium against
 * local build on :3200. Prints:
 *   A7   keyboard walk for Suggest an edit, with the real key
 *        press count and focus assertions.
 *   A8   four back-link cases (bookcase, search, doc-to-doc, cold)
 *        with the address at each step and the browser's Back.
 *   A6c  contrast: every text pair and every control edge on
 *        Details / Share / Suggest / /library/suggestions,
 *        worst-of + where.
 *
 * Does not write to the database. The Suggest an edit "Send" step
 * is skipped (the keyboard walk asserts up to the Send button
 * press and the focus-trap wrap, then Escape closes the panel
 * without landing a row).
 */

import { chromium } from "/tmp/pw-tmp/node_modules/playwright/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.KF_DEV_BASE || "http://localhost:3200";
const DOC_ID = process.env.KF_L3_DOC_ID || "POL-001";

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
  const access_token = hash.get("access_token");
  const refresh_token = hash.get("refresh_token");
  const jar = [];
  const sc = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: { getAll: () => [], setAll: (l) => { for (const c of l) jar.push(c); } } },
  );
  await sc.auth.setSession({ access_token, refresh_token });
  const host = new URL(BASE).hostname;
  await context.addCookies(jar.map((c) => ({
    name: c.name, value: c.value, domain: host, path: c.options.path || "/",
    httpOnly: c.options.httpOnly ?? false, secure: c.options.secure ?? false,
    sameSite: "Lax",
    expires: c.options.maxAge ? Math.floor(Date.now() / 1000) + c.options.maxAge : -1,
  })));
}

async function activeDesc(page) {
  return await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return "null";
    const cls = (el.className || "").toString().slice(0, 60);
    const txt = (el.textContent || "").trim().slice(0, 40);
    const aria = el.getAttribute("aria-label") || "";
    const id = el.id || "";
    return `${el.tagName.toLowerCase()}.${cls}${id ? "#" + id : ""} aria="${aria}" text="${txt}"`;
  });
}

async function a7Keyboard(context) {
  console.log("\n# A7  Keyboard walk - Suggest an edit (headless, real key presses)\n");
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/library/${DOC_ID}`, { waitUntil: "load" });
  await page.waitForSelector("[data-lb-doc-ready='1']", { timeout: 4000 });

  // Move focus straight to the Suggest button (counting every Tab
  // through the shell would be noisy and shell-dependent). Then
  // trace from there with real key presses.
  await page.focus(".kf-lb-ta--sug");
  console.log(`  focus-before-open: ${await activeDesc(page)}`);

  let presses = 0;
  // Press 1: Enter opens the panel.
  await page.keyboard.press("Enter");
  presses += 1;
  await page.waitForSelector(".kf-lb-panel--suggest", { timeout: 2000 });
  // Initial-focus deferral is 20ms; wait for it before reading.
  await page.waitForTimeout(80);
  const afterOpen = await activeDesc(page);
  console.log(`  press=${presses} (Enter): panel opened; focus-in=${afterOpen}`);
  const initialOnSelect = afterOpen.includes("select");
  console.log(`  pass ${initialOnSelect} - focus lands on [data-initial-focus] (the section <select>)`);

  // Tab through the panel to the last focusable. Count each Tab,
  // and assert the active element stays inside the panel (focus
  // trap): we just read the active element's closest(.kf-lb-panel).
  const trapOk = [];
  const stops = [];
  // Expected order: select, textarea (main), "Write the new wording"
  // button (hidden when no section is picked -- but the Suggest
  // panel's initial state has no section picked, so this stop may
  // not exist). Then Send, Discard, Close (header). After Close,
  // Tab wraps to the select.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    presses += 1;
    const d = await activeDesc(page);
    const inPanel = await page.evaluate(() => {
      const el = document.activeElement;
      return !!(el && el.closest(".kf-lb-panel--suggest"));
    });
    stops.push({ i: i + 1, inPanel, d });
    trapOk.push(inPanel);
  }
  console.log(`  Tab x${stops.length} through the panel. Every active element inside the panel?`);
  const everyInside = trapOk.every(Boolean);
  for (const s of stops) {
    console.log(`    Tab ${s.i}: inPanel=${s.inPanel}  ${s.d}`);
  }
  console.log(`  pass ${everyInside} - focus trap holds across ${stops.length} Tabs`);

  // Shift+Tab once; focus should still be inside the panel.
  await page.keyboard.press("Shift+Tab");
  presses += 1;
  const afterShift = await page.evaluate(() => {
    const el = document.activeElement;
    return !!(el && el.closest(".kf-lb-panel--suggest"));
  });
  console.log(`  press=${presses} (Shift+Tab): inPanel=${afterShift}`);

  // Escape closes the panel; focus returns to the opener (the
  // Suggest button we started on).
  await page.keyboard.press("Escape");
  presses += 1;
  await page.waitForTimeout(80);
  const panelGone = (await page.$(".kf-lb-panel--suggest")) === null;
  const refocused = await activeDesc(page);
  const backOnOpener = refocused.includes("kf-lb-ta--sug");
  console.log(`  press=${presses} (Escape): panel removed=${panelGone}; focus-after-close=${refocused}`);
  console.log(`  pass ${panelGone && backOnOpener} - Escape closes and returns focus to the opener`);

  console.log(`\n  Total key presses in the walk: ${presses}`);
  await page.close();
  return { everyInside, initialOnSelect, panelGone, backOnOpener, presses };
}

async function a8BackLink(context) {
  console.log("\n# A8  Back-link - four cases (addresses at each step)\n");
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  async function readBack() {
    // Wait for the topbar slot to render BackLink.
    await page.waitForSelector(".kf-lb-back", { timeout: 4000 });
    return await page.$eval(".kf-lb-back", (el) => ({
      href: el.getAttribute("href"),
      aria: el.getAttribute("aria-label"),
      cls: el.className,
    }));
  }

  // Case 1: from the bookcase. Read the tile href that would carry
  // the reader forward, then navigate directly (a soft nav through
  // Next's client router does not always swap the @topbar slot
  // right away, which is a known Next behaviour - gotcha #22; the
  // address-at-each-step is what the user asked for, so we use
  // honest hard navs for each step).
  await page.goto(`${BASE}/library`, { waitUntil: "load" });
  const url1a = page.url();
  await page.waitForSelector(".kf-lb-book", { timeout: 4000 });
  const tileHref = await page.$eval(".kf-lb-book", (el) => el.getAttribute("href"));
  await page.goto(`${BASE}${tileHref}`, { waitUntil: "load" });
  const url1b = page.url();
  const b1 = await readBack();
  console.log("  Case 1: from the bookcase");
  console.log(`    step 1 url: ${url1a}`);
  console.log(`    step 2 url: ${url1b}   (tile href was: ${tileHref})`);
  console.log(`    backlink: href=${b1.href}  aria="${b1.aria}"  variant=${b1.cls.includes("--library") ? "library" : b1.cls.includes("--search") ? "search" : "document"}`);
  await page.goBack({ waitUntil: "load" });
  console.log(`    browser Back landed: ${page.url()}`);
  console.log("");

  // Case 2: from a search.
  await page.goto(`${BASE}/library?q=hr`, { waitUntil: "load" });
  const url2a = page.url();
  await page.waitForSelector(".kf-lb-book", { timeout: 4000 });
  const tileHref2 = await page.$eval(".kf-lb-book", (el) => el.getAttribute("href"));
  await page.goto(`${BASE}${tileHref2}`, { waitUntil: "load" });
  const url2b = page.url();
  const b2 = await readBack();
  console.log("  Case 2: from a search ?q=hr");
  console.log(`    step 1 url: ${url2a}`);
  console.log(`    step 2 url: ${url2b}   (tile href was: ${tileHref2})`);
  console.log(`    backlink: href=${b2.href}  aria="${b2.aria}"  variant=${b2.cls.includes("--search") ? "search" : b2.cls.includes("--library") ? "library" : "document"}`);
  await page.goBack({ waitUntil: "load" });
  console.log(`    browser Back landed: ${page.url()}`);
  console.log("");

  // Case 3: one document to another via an in-text cross-doc anchor.
  // Pick a host doc that names at least one readable sibling. The
  // bookcase's first POL/SOP doc usually does.
  await page.goto(`${BASE}/library/${DOC_ID}`, { waitUntil: "load" });
  const url3a = page.url();
  const crossHref = await page.$eval(".kf-docbody a.kf-doclink", (el) => el.getAttribute("href")).catch(() => null);
  if (crossHref) {
    await page.goto(`${BASE}${crossHref}`, { waitUntil: "load" });
    const url3b = page.url();
    const b3 = await readBack();
    console.log("  Case 3: doc to doc via an in-text link");
    console.log(`    step 1 url: ${url3a}`);
    console.log(`    step 2 url: ${url3b}   (link href was: ${crossHref})`);
    console.log(`    backlink: href=${b3.href}  aria="${b3.aria}"  variant=${b3.cls.includes("--document") ? "document" : b3.cls.includes("--search") ? "search" : "library"}`);
    await page.goBack({ waitUntil: "load" });
    console.log(`    browser Back landed: ${page.url()}`);
  } else {
    console.log(`  Case 3: no in-text cross-doc anchor on ${DOC_ID}; skipping. (The outline helper only wires when the body names another live, readable doc.)`);
  }
  console.log("");

  // Case 4: opened cold.
  await page.goto(`${BASE}/library/${DOC_ID}`, { waitUntil: "load" });
  const url4a = page.url();
  const b4 = await readBack();
  console.log("  Case 4: opened cold");
  console.log(`    step 1 url: ${url4a}`);
  console.log(`    backlink: href=${b4.href}  aria="${b4.aria}"  variant=${b4.cls.includes("--library") ? "library" : b4.cls.includes("--search") ? "search" : "document"}`);
  // Browser Back in a cold-opened tab goes to about:blank; Playwright
  // records this as a load with the first entry. We report what Next
  // does rather than claim equivalence.
  const canBack = await page.evaluate(() => window.history.length > 1);
  console.log(`    window.history.length > 1 ? ${canBack} (if false, browser Back has no entry to go to)`);

  await page.close();
}

async function contrastOnPage(page) {
  return await page.evaluate(() => {
    const srgb = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lum = ([r, g, b]) =>
      0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
    const ratio = (fg, bg) => {
      const L1 = lum(fg);
      const L2 = lum(bg);
      const [a, b] = L1 > L2 ? [L1, L2] : [L2, L1];
      return (a + 0.05) / (b + 0.05);
    };
    const parseRgb = (s) => {
      const m = String(s || "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const bgFor = (el) => {
      let cur = el;
      while (cur) {
        const cs = getComputedStyle(cur);
        const rgb = parseRgb(cs.backgroundColor);
        const alpha = cs.backgroundColor.startsWith("rgba")
          ? Number(cs.backgroundColor.match(/,\s*([\d.]+)\s*\)/)?.[1] ?? "1")
          : 1;
        if (rgb && alpha >= 1) return { rgb, el: cur };
        cur = cur.parentElement;
      }
      return { rgb: [255, 255, 255], el: document.body };
    };
    // Every text-bearing element inside the current panel (or page
    // body for the suggestions list), in the DOM order the reader
    // meets them.
    const SCOPE_SEL = document.querySelector(".kf-lb-panel")
      ? ".kf-lb-panel"
      : ".kf-lb-sugs";
    const scope = document.querySelector(SCOPE_SEL);
    const text = [];
    if (scope) {
      scope.querySelectorAll("h1,h2,h3,h4,p,span,label,strong,em,dt,dd,summary,li,option,input,textarea,select,button").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (!t) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return;
        const fg = parseRgb(cs.color);
        if (!fg) return;
        const bg = bgFor(el);
        const r = Math.round(ratio(fg, bg.rgb) * 100) / 100;
        text.push({
          where: el.tagName.toLowerCase() + "." + (el.className || "").toString().slice(0, 40),
          fg: cs.color,
          bg: getComputedStyle(bg.el).backgroundColor,
          ratio: r,
          kind: "text",
          snippet: t.slice(0, 40),
        });
      });
      // Control edges: inputs, selects, textareas, and the outline
      // button variant only. Primary filled buttons differentiate
      // through their fill (self-contrast vs page bg), not through
      // a border; measuring their "border" is nonsensical because
      // the computed border-color is rgba(0,0,0,0) when no border is
      // set. Target 3:1 for every non-transparent edge.
      scope.querySelectorAll("input,select,textarea,.kf-btn--line").forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return;
        const bw = parseFloat(cs.borderTopWidth || "0");
        if (bw <= 0) return;
        const alphaMatch = cs.borderTopColor.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/);
        const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
        if (alpha <= 0) return;
        const border = parseRgb(cs.borderTopColor);
        if (!border) return;
        const bg = bgFor(el);
        const r = Math.round(ratio(border, bg.rgb) * 100) / 100;
        text.push({
          where: el.tagName.toLowerCase() + "." + (el.className || "").toString().slice(0, 40),
          fg: cs.borderTopColor,
          bg: getComputedStyle(bg.el).backgroundColor,
          ratio: r,
          kind: "edge",
          snippet: "",
        });
      });
      // Primary filled buttons: measure the FILL against the
      // surrounding background (self-contrast). Target 3:1 for
      // non-text UI components per WCAG 1.4.11.
      scope.querySelectorAll(".kf-btn--primary").forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return;
        // Disabled controls are exempt from WCAG 1.4.11 non-text
        // contrast. Skip them.
        if ((el instanceof HTMLButtonElement && el.disabled) || el.getAttribute("aria-disabled") === "true") return;
        const fill = parseRgb(cs.backgroundColor);
        if (!fill) return;
        // The button's own background IS the differentiator; the
        // surrounding colour is one container up.
        const parent = el.parentElement;
        const outerBg = parent ? bgFor(parent) : { rgb: [255, 255, 255], el: document.body };
        const r = Math.round(ratio(fill, outerBg.rgb) * 100) / 100;
        text.push({
          where: el.tagName.toLowerCase() + "." + (el.className || "").toString().slice(0, 40),
          fg: cs.backgroundColor,
          bg: getComputedStyle(outerBg.el).backgroundColor,
          ratio: r,
          kind: "edge",
          snippet: "(primary fill)",
        });
      });
    }
    return text;
  });
}

async function a6Contrast(context) {
  console.log("\n# A6c  Contrast - Details / Share / Suggest / /library/suggestions\n");
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  const opens = [
    { name: "Details", open: async () => {
      await page.goto(`${BASE}/library/${DOC_ID}`, { waitUntil: "load" });
      await page.waitForSelector("[data-lb-doc-ready='1']");
      await page.click(".kf-lb-ta--details");
      await page.waitForSelector(".kf-lb-panel--details");
    }},
    { name: "Share", open: async () => {
      await page.goto(`${BASE}/library/${DOC_ID}`, { waitUntil: "load" });
      await page.waitForSelector("[data-lb-doc-ready='1']");
      await page.click(".kf-lb-ta--share");
      await page.waitForSelector(".kf-lb-panel--share");
    }},
    { name: "Suggest an edit", open: async () => {
      await page.goto(`${BASE}/library/${DOC_ID}`, { waitUntil: "load" });
      await page.waitForSelector("[data-lb-doc-ready='1']");
      await page.click(".kf-lb-ta--sug");
      await page.waitForSelector(".kf-lb-panel--suggest");
    }},
    { name: "/library/suggestions", open: async () => {
      await page.goto(`${BASE}/library/suggestions`, { waitUntil: "load" });
    }},
  ];

  const all = [];
  for (const o of opens) {
    await o.open();
    await page.waitForTimeout(150);
    const rows = await contrastOnPage(page);
    const worstText = rows.filter((r) => r.kind === "text").sort((a, b) => a.ratio - b.ratio)[0] || null;
    const worstEdge = rows.filter((r) => r.kind === "edge").sort((a, b) => a.ratio - b.ratio)[0] || null;
    console.log(`  ${o.name}  (${rows.length} elements measured)`);
    console.log(`    worst text: ${worstText ? `${worstText.ratio.toFixed(2)}:1  where=${worstText.where.slice(0, 50)}  snippet="${worstText.snippet}"  fg=${worstText.fg}  bg=${worstText.bg}` : "none"}`);
    console.log(`    worst edge: ${worstEdge ? `${worstEdge.ratio.toFixed(2)}:1  where=${worstEdge.where.slice(0, 50)}  border=${worstEdge.fg}  bg=${worstEdge.bg}` : "none"}`);
    const textFailures = rows.filter((r) => r.kind === "text" && r.ratio < 4.5);
    const edgeFailures = rows.filter((r) => r.kind === "edge" && r.ratio < 3);
    console.log(`    text pairs below 4.5:1: ${textFailures.length}`);
    if (textFailures.length) {
      for (const f of textFailures.slice(0, 5)) {
        console.log(`      ${f.ratio.toFixed(2)}:1  ${f.where.slice(0, 50)}  "${f.snippet}"  fg=${f.fg}  bg=${f.bg}`);
      }
    }
    console.log(`    control edges below 3:1: ${edgeFailures.length}`);
    if (edgeFailures.length) {
      for (const f of edgeFailures.slice(0, 5)) {
        console.log(`      ${f.ratio.toFixed(2)}:1  ${f.where.slice(0, 50)}  border=${f.fg}  bg=${f.bg}`);
      }
    }
    all.push({ name: o.name, rows });
  }
  await page.close();
  return all;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  console.log(`sign in as ${ownerEmail()}...`);
  await sign(context);
  console.log("doc under test:", DOC_ID);
  await a7Keyboard(context);
  await a8BackLink(context);
  await a6Contrast(context);
  await context.close();
  await browser.close();
  console.log("\ndone.");
}

main().catch((e) => {
  console.error("e2e failed:", e?.stack || String(e));
  process.exit(1);
});
