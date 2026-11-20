#!/usr/bin/env node
/**
 * Clipped-text probe. Open the document page at 360 wide and print
 * every element whose scrollWidth exceeds clientWidth. Used to
 * identify the single "clipped 1" offender the L3 battery saw.
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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 360, height: 900 } });
  await sign(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/library/${DOC_ID}`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  const offenders = await page.evaluate(() => {
    const rows = [];
    document.querySelectorAll("*").forEach((el) => {
      const t = (el.textContent || "").trim();
      if (!t) return;
      if (el.childElementCount > 0) return;
      const cs = getComputedStyle(el);
      if (cs.position === "absolute" &&
        (cs.clip === "rect(0px, 0px, 0px, 0px)" ||
          (parseFloat(cs.width) <= 2 && parseFloat(cs.height) <= 2))) return;
      if (el.scrollWidth > el.clientWidth + 1) {
        rows.push({
          tag: el.tagName,
          cls: el.className,
          text: t.slice(0, 80),
          sw: el.scrollWidth,
          cw: el.clientWidth,
          over: el.scrollWidth - el.clientWidth,
        });
      }
    });
    return rows;
  });
  console.log("clipped offenders at 360 wide:");
  for (const r of offenders) {
    console.log(`  ${r.tag}.${(r.cls || "").toString().slice(0, 60)} over=${r.over}px (sw=${r.sw}, cw=${r.cw}) text="${r.text}"`);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
