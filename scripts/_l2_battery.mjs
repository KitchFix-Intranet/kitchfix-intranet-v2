#!/usr/bin/env node
/**
 * Library L2 battery. Playwright, against the dev server on :3100.
 *
 * Sign-in: this repo's supabase project does not list
 * `http://localhost:3100` among its allowed redirect URLs, so the
 * admin generateLink flow returns the session on the hash of the
 * project's prod SITE_URL. We extract `access_token` and
 * `refresh_token` from that redirect URL, then inject them into a
 * Supabase browser client inside Playwright on localhost. The
 * browser client writes the `@supabase/ssr` cookies on the right
 * domain, and the dev server reads them like a normal signed-in
 * session. No code change to the app; no credentials ever printed.
 *
 * The dev server must already be running on 3100. Screenshots land
 * under /tmp/kf-v2-library-l2-shots/.
 */

import { chromium } from "/tmp/pw-tmp/node_modules/playwright/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.KF_DEV_BASE || "http://localhost:3100";
const SHOTS_DIR = "/tmp/kf-v2-library-l2-shots";
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

  // Follow the verify URL once, record the Location header.
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

  // Use `@supabase/ssr` (already in the app's node_modules) with an
  // in-memory cookie jar to materialize the SSR cookies that
  // `createServerClient` would normally write via a NextResponse.
  // We then inject those cookies into Playwright's browser context.
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
    sameSite: (c.options.sameSite ?? "Lax")
      .charAt(0).toUpperCase() + (c.options.sameSite ?? "ax").slice(1),
    expires: c.options.maxAge
      ? Math.floor(Date.now() / 1000) + c.options.maxAge
      : -1,
  }));
  await context.addCookies(playwrightCookies);
  return { ok: true, count: playwrightCookies.length };
}

const DISTINCT_FONT_SIZES_SELECTOR =
  "h1,h2,h3,h4,p,span,b,strong,em,small,label,input,button,a,li,dt,dd,summary";

async function measureContrast(page) {
  return await page.evaluate(() => {
    // WCAG 2.1 relative-luminance + contrast ratio.
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
    // Every text-bearing surface on the bookcase. The band + phone-top
    // are included even though the band comes from the shared shell
    // component; the bookcase renders through it, so a contrast report
    // for a reader opening /library has to cover what is on screen.
    const SELECTORS = [
      ".kf-band__title",
      ".kf-band__kick-text",
      ".kf-eyebrow",
      ".kf-lb-phonetop__t",
      ".kf-lb-phonetop__k",
      ".kf-lb-search__input",
      ".kf-lb-rail__title",
      ".kf-lb-rail__meta",
      ".kf-lb-shelfnav__t",
      ".kf-lb-shelfnav__c",
      ".kf-lb-shelf__h h2",
      ".kf-lb-shelf__meta",
      ".kf-lb-book__n",
      ".kf-lb-book__k",
      ".kf-lb-book__t",
      ".kf-lb-book__l",
      ".kf-lb-book__v",
      ".kf-lb-book__mark",
      ".kf-lb-matchcount",
      ".kf-empty__title",
      ".kf-empty__body",
      ".kf-lb-shelfjump a",
      ".kf-lb-shelfjump__count",
    ];
    const text = [];
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const fg = parseRgb(cs.color);
      const bg = bgFor(el);
      if (!fg) continue;
      text.push({
        sel,
        fg: cs.color,
        bg: getComputedStyle(bg.el).backgroundColor,
        ratio: Math.round(ratio(fg, bg.rgb) * 100) / 100,
      });
    }
    // Search field edge. 3:1 is the non-text UI target.
    const sb = document.querySelector(".kf-lb-search");
    let edge = null;
    if (sb) {
      const cs = getComputedStyle(sb);
      const border = parseRgb(cs.borderTopColor);
      const bgRgb = parseRgb(cs.backgroundColor) || [255, 255, 255];
      if (border) {
        edge = {
          border: cs.borderTopColor,
          bg: cs.backgroundColor,
          ratio: Math.round(ratio(border, bgRgb) * 100) / 100,
        };
      }
    }
    return { text, edge };
  });
}

async function measureBattery(page) {
  return await page.evaluate((sel) => {
    const hScroll =
      document.documentElement.scrollWidth > document.documentElement.clientWidth;
    let underFloor = 0;
    const offenders = [];
    document.querySelectorAll("button,a,input").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      // Skip visually hidden elements (common for sr-only).
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return;
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
    const clippedOffenders = [];
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.textContent || "").trim();
      if (!t) return;
      const children = el.childElementCount;
      if (children > 0) return;
      // Skip intentional sr-only (clip + absolute + 1px). The battery
      // is after readable text that gets clipped visually - not after
      // the standard accessibility pattern of an off-screen live
      // region.
      const cs = getComputedStyle(el);
      if (
        cs.position === "absolute" &&
        (cs.clip === "rect(0px, 0px, 0px, 0px)" ||
          (parseFloat(cs.width) <= 2 && parseFloat(cs.height) <= 2))
      ) {
        return;
      }
      if (el.scrollWidth > el.clientWidth + 1) {
        clipped += 1;
        if (clippedOffenders.length < 3) {
          clippedOffenders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 50)}`);
        }
      }
    });
    return {
      hScroll,
      underFloor,
      offenders,
      sizes: [...sizes].sort((a, b) => a - b),
      clipped,
      clippedOffenders,
    };
  }, DISTINCT_FONT_SIZES_SELECTOR);
}

async function openState(page, state) {
  if (state === "bookcase") {
    await page.goto(`${BASE}/library`, { waitUntil: "load" });
  } else if (state === "scrolled") {
    await page.goto(`${BASE}/library`, { waitUntil: "load" });
    await page.evaluate(() => {
      const shelves = document.querySelectorAll(".kf-lb-shelf");
      const last = shelves[shelves.length - 1];
      last?.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await page.waitForTimeout(100);
  } else if (state === "search-results") {
    await page.goto(`${BASE}/library?q=safety`, { waitUntil: "load" });
  } else if (state === "search-none") {
    await page.goto(`${BASE}/library?q=zzzqqqzzzxxx`, { waitUntil: "load" });
  }
  await page.waitForTimeout(150);
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
  const cs = await context.cookies();
  console.log("  cookie names:", cs.map((c) => c.name));

  // Sanity check: /library should render, not 404.
  const probe = await context.newPage();
  const resp = await probe.goto(`${BASE}/library`, { waitUntil: "load" });
  console.log("probe /library status:", resp?.status());
  console.log("probe url after nav:", probe.url());
  const body = await probe.textContent("body");
  console.log("probe body sample:", body?.slice(0, 200));
  const h = await probe.$eval("h2.kf-band__title, h1.kf-lb-phonetop__t", (el) => el.textContent?.trim() || "").catch(() => "(not found)");
  console.log("probe headline:", h);
  await probe.close();

  // Sweep. Each cell is its own fresh page; we pool with retries in
  // case next-start trips under load.
  const widths = [];
  for (let w = 360; w <= 1920; w += 40) widths.push(w);
  const states = ["bookcase", "scrolled", "search-results", "search-none"];
  const rows = [];
  for (const state of states) {
    for (const w of widths) {
      let attempts = 0;
      let measured = null;
      while (attempts < 3 && !measured) {
        attempts += 1;
        const page = await context.newPage();
        try {
          await page.setViewportSize({ width: w, height: Math.max(700, Math.min(w, 900)) });
          await openState(page, state);
          measured = await measureBattery(page);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  ${state}@${w} attempt ${attempts} failed: ${msg.slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        try { await page.close(); } catch {}
      }
      rows.push({ state, width: w, ...(measured ?? { hScroll: null, underFloor: null, offenders: [], sizes: [], clipped: null, failed: true }) });
    }
  }

  const summary = [];
  for (const state of states) {
    const rs = rows.filter((r) => r.state === state);
    const hScrollW = rs.filter((r) => r.hScroll).map((r) => r.width);
    const underW = rs.filter((r) => r.underFloor > 0).map((r) => `${r.width}(${r.underFloor})`);
    const maxSizes = Math.max(...rs.map((r) => r.sizes.length));
    const sizesOverW = rs.filter((r) => r.sizes.length > 5).map((r) => `${r.width}(${r.sizes.length})`);
    const clippedW = rs.filter((r) => r.clipped > 0).map((r) => `${r.width}(${r.clipped})`);
    summary.push({ state, hScrollW, underW, maxSizes, sizesOverW, clippedW });
  }

  // Contrast pass. Each of the four states at the four screenshot
  // widths (390/820/1280/1440) - contrast ratios do not change with
  // width in this layout, so a width sample is enough.
  const contrast = { byState: {} };
  for (const state of states) {
    contrast.byState[state] = {};
    for (const w of [390, 820, 1280, 1440]) {
      const page = await context.newPage();
      await page.setViewportSize({ width: w, height: Math.max(900, w) });
      await openState(page, state);
      try {
        contrast.byState[state][w] = await measureContrast(page);
      } catch (err) {
        contrast.byState[state][w] = { error: String(err?.message || err) };
      }
      await page.close();
    }
  }

  // Worst-of text pair across every state+width, and worst edge.
  const allText = [];
  let worstEdge = { ratio: Infinity };
  for (const state of states) {
    for (const w of [390, 820, 1280, 1440]) {
      const c = contrast.byState[state][w];
      if (!c?.text) continue;
      for (const row of c.text) allText.push({ state, width: w, ...row });
      if (c.edge && c.edge.ratio < worstEdge.ratio) {
        worstEdge = { state, width: w, ...c.edge };
      }
    }
  }
  const worstText = [...allText]
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 8);

  console.log("\nA3 - contrast (worst 8 text pairs, every state+width sampled):");
  for (const r of worstText) {
    console.log(
      `  ${r.ratio.toFixed(2)}:1  ${r.sel.padEnd(28)}  state=${r.state} w=${r.width}  fg=${r.fg}  bg=${r.bg}`,
    );
  }
  console.log(
    `  search field edge: worst=${worstEdge.ratio.toFixed(2)}:1  state=${worstEdge.state} w=${worstEdge.width}  border=${worstEdge.border}  bg=${worstEdge.bg}`,
  );

  writeFileSync(
    `${SHOTS_DIR}/contrast.json`,
    JSON.stringify(contrast, null, 2),
  );

  console.log("\nA3 - battery sweep (worst-of per check):\n");
  for (const s of summary) {
    console.log("---", s.state, "---");
    console.log(`  hScroll (widths)      ${s.hScrollW.length ? s.hScrollW.join(",") : "-"}`);
    console.log(`  under48 (width(n))    ${s.underW.length ? s.underW.join(",") : "-"}`);
    console.log(`  max distinct sizes    ${s.maxSizes}`);
    console.log(`  sizes>5 (width(n))    ${s.sizesOverW.length ? s.sizesOverW.join(",") : "-"}`);
    console.log(`  clipped (width(n))    ${s.clippedW.length ? s.clippedW.join(",") : "-"}`);
  }
  console.log(`\nconsole errors seen: ${consoleErrors.length}`);
  if (consoleErrors.length) {
    const seen = new Set();
    for (const e of consoleErrors) {
      const k = e.msg.slice(0, 120);
      if (seen.has(k)) continue;
      seen.add(k);
      console.log("  -", k);
      if (seen.size >= 6) break;
    }
  }

  writeFileSync(`${SHOTS_DIR}/battery.json`, JSON.stringify(rows, null, 2));
  console.log(`\nfull sweep JSON: ${SHOTS_DIR}/battery.json`);

  console.log("\nA8 - screenshots:");
  // Owner viewer sees every document. The repo is public so, before
  // every shot, we blur the words the tile carries (title / card
  // line / id / rail counts) so no restricted document's title or
  // client name can leak through the saved image. Kind icons, shelf
  // headings, chrome and layout survive - which is what the shot is
  // there to communicate.
  const BLUR_CSS = `
    .kf-lb-book__t, .kf-lb-book__l, .kf-lb-book__n,
    .kf-lb-shelf__h h2, .kf-lb-shelfnav__t,
    .kf-rail__account, .kf-rail__item span, .kf-topbar__title { filter: blur(5px) !important; }
  `;
  for (const state of ["bookcase", "search-results"]) {
    for (const w of [390, 820, 1280, 1440]) {
      const page = await context.newPage();
      await page.setViewportSize({ width: w, height: Math.max(900, w) });
      await openState(page, state);
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
