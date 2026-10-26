// scripts/_academy_parity.ts
//
// Parity harness: run v1 Academy loaders and v2 TS loaders against
// the same database for one person, diff per surface.
//
// Usage (from v2 clone, with .env.local populated):
//   node --env-file=.env.local --import tsx scripts/_academy_parity.ts \
//     <v1-clone-path> <email>
//
// Example:
//   node --env-file=.env.local --import tsx scripts/_academy_parity.ts \
//     ~/dev/kitchfix-intranet-main k.fietek@kitchfix.com
//
// Prints JSON per surface:
//   { surface: "...", v1: {...}, v2: {...}, diff: {...} }
// Expected: diff empty except for the known difference set documented
// in the port prompt (TEST_MODE branches gone, attestation_text fields
// v1 never returned, etc.). Any other difference is a port error.
//
// How v1 is executed:
//   Each v1 route handler is loaded via dynamic import after a
//   lightweight text rewrite that stubs the `@/lib/auth` + `@/lib/
//   supabase` aliases with a session that pretends the requested
//   email is signed in, and that always treats the caller as inside
//   the preview allowlist. Everything else is v1's own code running
//   against v1's own node_modules. The rewritten modules are
//   written into `${v1Path}/scripts/.parity-tmp/` (inside the v1
//   clone, so `next/server` + `@supabase/supabase-js` resolve from
//   v1's dependencies) and removed afterwards.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { serviceClient } from "../src/lib/supabase/service";
import { resolveAcademyIdentity, eligibleCountInScope } from "../src/lib/academy/identity";
import { loadRoom } from "../src/lib/academy/room";
import { loadLibrary } from "../src/lib/academy/library";
import { loadRecords } from "../src/lib/academy/records";
import { loadModule } from "../src/lib/academy/module";

type Json = unknown;

const [, , v1PathArg, emailArg] = process.argv;
if (!v1PathArg || !emailArg) {
  console.error("Usage: ... scripts/_academy_parity.ts <v1-path> <email>");
  process.exit(2);
}
const v1Path = pathResolve(v1PathArg);
const email = String(emailArg).trim().toLowerCase();

if (!existsSync(join(v1Path, "src/lib/academy/resolveIdentity.js"))) {
  console.error(`[parity] v1 clone not found at ${v1Path}`);
  process.exit(2);
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[parity] SUPABASE_SERVICE_ROLE_KEY not set in environment");
  process.exit(2);
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error("[parity] NEXT_PUBLIC_SUPABASE_URL not set in environment");
  process.exit(2);
}

const tmpDir = join(v1Path, "scripts", ".parity-tmp");
mkdirSync(tmpDir, { recursive: true });

function pathUrl(p: string): string {
  return pathToFileURL(p).href;
}

function cleanup(): void {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ─── v1 handler execution via text-rewrite + dynamic import ─────────

interface V1RunOptions {
  routeFile: string; // relative path inside v1 clone, e.g. "src/app/api/academy/room/route.js"
  email: string;
  params?: Record<string, string>;
}

// Produce a shimmed copy of v1's resolveIdentity.js once per invocation.
// Two mods:
//   1. `@/lib/supabase` -> absolute file:// to v1's src/lib/supabase.js
//      (raw Node ESM has no path aliases).
//   2. ACADEMY_PREVIEW_ONLY -> false. The v2 fence is OWNER_EMAILS at
//      the route edge, which replaces v1's hardcoded Kevin-only pilot
//      gate. Leaving the v1 fence closed would surface Kevin-only
//      allowlist rejection as the "diff" for every other owner we
//      probe; we want the DATA-LAYER parity to show. Documented in
//      the script header.
let _shimmedIdentityUrl: string | null = null;
function shimmedV1Identity(): string {
  if (_shimmedIdentityUrl) return _shimmedIdentityUrl;
  const idSrc = readFileSync(join(v1Path, "src/lib/academy/resolveIdentity.js"), "utf8");
  const v1SupabaseUrl = pathUrl(join(v1Path, "src/lib/supabase.js"));
  const transformed = idSrc
    .replace(
      /import\s*{\s*getServiceClient\s*}\s*from\s*["']@\/lib\/supabase["']\s*;?\s*/g,
      `import { getServiceClient } from ${JSON.stringify(v1SupabaseUrl)};\n`
    )
    .replace(
      /export\s+const\s+ACADEMY_PREVIEW_ONLY\s*=\s*true\s*;?/,
      "export const ACADEMY_PREVIEW_ONLY = false;"
    );
  const outPath = join(tmpDir, "resolveIdentity.shim.mjs");
  writeFileSync(outPath, transformed);
  _shimmedIdentityUrl = pathUrl(outPath);
  return _shimmedIdentityUrl;
}

async function runV1Handler(opts: V1RunOptions): Promise<{ status: number; body: Json }> {
  const absRoute = join(v1Path, opts.routeFile);
  const src = readFileSync(absRoute, "utf8");

  const v1IdentityUrl = shimmedV1Identity();
  const v1SupabasePath = join(v1Path, "src/lib/supabase.js");
  const v1SupabaseUrl = pathUrl(v1SupabasePath);
  const v1CertPdfPath = join(v1Path, "src/lib/academy/certificatePdf.js");
  const v1CertPdfUrl = pathUrl(v1CertPdfPath);

  // Shim auth + replace alias imports. v1's getServiceClient uses
  // SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; v2's env has
  // NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Export
  // SUPABASE_URL from the subprocess env (see spawn below).
  // Also strip the `next/server` import - raw Node ESM does not
  // auto-add .js extensions. A tiny inline NextResponse shim replaces
  // it; the handlers only use NextResponse.json({...}, { status }).
  const transformed = src
    .replace(
      /import\s*{\s*NextResponse\s*}\s*from\s*["']next\/server["']\s*;?\s*/g,
      ""
    )
    .replace(
      /import\s*{\s*auth\s*}\s*from\s*["']@\/lib\/auth["']\s*;?\s*/g,
      "const auth = async () => ({ user: { email: _PARITY_EMAIL } });\n"
    )
    .replace(
      /import\s*{\s*getServiceClient\s*}\s*from\s*["']@\/lib\/supabase["']\s*;?\s*/g,
      `import { getServiceClient } from ${JSON.stringify(v1SupabaseUrl)};\n`
    )
    .replace(
      /from\s*["']@\/lib\/academy\/resolveIdentity["']/g,
      `from ${JSON.stringify(v1IdentityUrl)}`
    )
    .replace(
      /from\s*["']@\/lib\/academy\/certificatePdf["']/g,
      `from ${JSON.stringify(v1CertPdfUrl)}`
    );

  const header = `
const _PARITY_EMAIL = ${JSON.stringify(opts.email)};
const NextResponse = {
  json(body, init) {
    const status = (init && init.status) || 200;
    const headers = new Headers({ "content-type": "application/json" });
    return new Response(JSON.stringify(body), { status, headers });
  },
};
`;
  const script = header + transformed;

  // Write into the v1 clone's own tree so NextResponse + supabase-js
  // resolve from v1's node_modules.
  const fname = opts.routeFile.replace(/[\/\[\]]/g, "_") + ".mjs";
  const outPath = join(tmpDir, fname);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, script);

  const runnerPath = join(tmpDir, fname + ".runner.mjs");
  const paramsLiteral = JSON.stringify(opts.params || {});
  const runner = `
import { pathToFileURL } from "node:url";
const url = ${JSON.stringify(pathUrl(outPath))};
const mod = await import(url);
const req = new Request("http://parity.local/");
const params = ${paramsLiteral};
let res;
if (mod.GET.length >= 2) {
  res = await mod.GET(req, { params: Promise.resolve(params) });
} else {
  res = await mod.GET(req);
}
const ct = res.headers.get("content-type") || "";
let body;
if (ct.includes("application/json")) {
  body = await res.json();
} else if (ct.includes("application/pdf")) {
  const buf = Buffer.from(await res.arrayBuffer());
  body = { _pdf_bytes: buf.length };
} else {
  body = { _text: await res.text() };
}
process.stdout.write(JSON.stringify({ status: res.status, body }));
`;
  writeFileSync(runnerPath, runner);

  const env = {
    ...process.env,
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  };

  const result: { status: number; body: Json } = await new Promise((resolve, reject) => {
    // Subprocess is plain ESM .mjs - no tsx needed. v1 does not have tsx
    // as a dependency anyway.
    const proc = spawn("node", [runnerPath], {
      cwd: v1Path,
      env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `[parity] v1 runner (${opts.routeFile}) exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { status: number; body: Json });
      } catch (e) {
        reject(
          new Error(
            `[parity] v1 runner (${opts.routeFile}) produced non-JSON\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
      }
    });
  });
  return result;
}

// ─── diff helpers ────────────────────────────────────────────────

function sortedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort();
}

function canonicalize(x: Json): Json {
  if (x === null) return null;
  if (Array.isArray(x)) return x.map(canonicalize);
  if (typeof x === "object") {
    const obj = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys(obj)) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return x;
}

type DiffPath = Array<string | number>;
interface Difference {
  path: DiffPath;
  v1: Json;
  v2: Json;
}

// Deep diff that elides a set of known-ignorable keys. Returns a
// list of (path, v1-value, v2-value) tuples - empty = equal.
function diffJson(
  a: Json,
  b: Json,
  path: DiffPath = [],
  ignoreKeys: Set<string> = new Set()
): Difference[] {
  if (a === b) return [];
  if (a === null || b === null) {
    return [{ path, v1: a, v2: b }];
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const diffs: Difference[] = [];
    if (a.length !== b.length) {
      diffs.push({ path: [...path, "length"], v1: a.length, v2: b.length });
    }
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i += 1) {
      diffs.push(...diffJson(a[i], b[i], [...path, i], ignoreKeys));
    }
    return diffs;
  }
  if (typeof a === "object" && typeof b === "object") {
    const diffs: Difference[] = [];
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      if (ignoreKeys.has(k)) continue;
      diffs.push(...diffJson(ao[k], bo[k], [...path, k], ignoreKeys));
    }
    return diffs;
  }
  if (typeof a === typeof b && a !== b) {
    return [{ path, v1: a, v2: b }];
  }
  if (typeof a !== typeof b) {
    return [{ path, v1: a, v2: b }];
  }
  return [];
}

// Timestamps + run-local timings are not evidence of a port error.
const COMMON_IGNORE_KEYS = new Set([
  "last_seen_at", // module_progress upsert bumps NOW on every fetch
  "started_at", // same
  "rendered_at", // document_content rendered_at not stable
  "issued_at", // may differ by microseconds
  "attempted_at",
]);

function formatPath(p: DiffPath): string {
  return p
    .map((x) => (typeof x === "number" ? `[${x}]` : `.${x}`))
    .join("")
    .replace(/^\./, "");
}

function summarizeDiffs(diffs: Difference[]): string {
  if (diffs.length === 0) return "  (none)";
  return diffs
    .slice(0, 50)
    .map(
      (d) =>
        `  @${formatPath(d.path)}: v1=${JSON.stringify(d.v1)} v2=${JSON.stringify(d.v2)}`
    )
    .concat(diffs.length > 50 ? [`  ... ${diffs.length - 50} more`] : [])
    .join("\n");
}

// Count every leaf comparison a diff pass would have made, so a
// "diffs=0" result is distinguishable from "nothing was compared".
// Also records container sizes so zero-length arrays are visible.
interface CompareShape {
  leaves: number;
  objects: number;
  arrays: number;
  arrayLens: Record<string, number>;
}
function shapeStats(x: Json, path: DiffPath = [], acc?: CompareShape): CompareShape {
  const a = acc || { leaves: 0, objects: 0, arrays: 0, arrayLens: {} };
  if (x === null || typeof x !== "object") {
    a.leaves += 1;
    return a;
  }
  if (Array.isArray(x)) {
    a.arrays += 1;
    a.arrayLens[formatPath(path) || "(root)"] = x.length;
    for (let i = 0; i < x.length; i += 1) {
      shapeStats(x[i], [...path, i], a);
    }
    return a;
  }
  a.objects += 1;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    shapeStats(v, [...path, k], a);
  }
  return a;
}
function summarizeShape(x: Json): string {
  const s = shapeStats(x);
  const topArrays = Object.entries(s.arrayLens)
    .sort(([, la], [, lb]) => lb - la)
    .slice(0, 4)
    .map(([p, l]) => `${p || "(root)"}=${l}`)
    .join(", ");
  return `leaves=${s.leaves} objects=${s.objects} arrays=${s.arrays}${
    topArrays ? ` (top: ${topArrays})` : ""
  }`;
}

// ─── main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const supa = serviceClient();

  const results: Array<{
    surface: string;
    status1: number;
    status2: number;
    diffs: Difference[];
    shapeV1: string;
    shapeV2: string;
  }> = [];

  // 1. whoami
  {
    const v1 = await runV1Handler({
      routeFile: "src/app/api/academy/whoami/route.js",
      email,
    });
    const v2Identity = await resolveAcademyIdentity(email, { supa });
    let v2Body: Json;
    let v2Status: number;
    if (!v2Identity) {
      v2Body = {
        ok: true,
        identity: null,
        canSeeStandingCard: false,
        canSeeHourlyRoster: false,
        eligibleCountInScope: { salaried: 0, hourly: 0, total: 0 },
        resolvedFor: email,
        reason: "no active roster row for this email",
      };
      v2Status = 200;
    } else {
      const counts = await eligibleCountInScope(v2Identity, { supa });
      v2Body = {
        ok: true,
        resolvedFor: email,
        identity: v2Identity,
        canSeeStandingCard: counts.salaried > 0,
        canSeeHourlyRoster: counts.hourly > 0,
        eligibleCountInScope: counts,
      };
      v2Status = 200;
    }
    const diffs = diffJson(canonicalize(v1.body), canonicalize(v2Body), [], COMMON_IGNORE_KEYS);
    results.push({
      surface: "whoami",
      status1: v1.status,
      status2: v2Status,
      diffs,
      shapeV1: summarizeShape(canonicalize(v1.body)),
      shapeV2: summarizeShape(canonicalize(v2Body)),
    });
  }

  // 2. room
  {
    const v1 = await runV1Handler({
      routeFile: "src/app/api/academy/room/route.js",
      email,
    });
    const v2 = await loadRoom(email, supa);
    const v2Status = v2.ok ? 200 : v2.status;
    const v2Body: Json = v2.ok ? v2 : v2;
    const diffs = diffJson(canonicalize(v1.body), canonicalize(v2Body), [], COMMON_IGNORE_KEYS);
    results.push({
      surface: "room",
      status1: v1.status,
      status2: v2Status,
      diffs,
      shapeV1: summarizeShape(canonicalize(v1.body)),
      shapeV2: summarizeShape(canonicalize(v2Body)),
    });
  }

  // 3. library
  {
    const v1 = await runV1Handler({
      routeFile: "src/app/api/academy/library/route.js",
      email,
    });
    const v2 = await loadLibrary(email, supa);
    const v2Status = v2.ok ? 200 : v2.status;
    const v2Body: Json = v2.ok ? v2 : v2;
    const diffs = diffJson(canonicalize(v1.body), canonicalize(v2Body), [], COMMON_IGNORE_KEYS);
    results.push({
      surface: "library",
      status1: v1.status,
      status2: v2Status,
      diffs,
      shapeV1: summarizeShape(canonicalize(v1.body)),
      shapeV2: summarizeShape(canonicalize(v2Body)),
    });
  }

  // 4. records
  {
    const v1 = await runV1Handler({
      routeFile: "src/app/api/academy/records/route.js",
      email,
    });
    const v2 = await loadRecords(email, supa);
    const v2Status = v2.ok ? 200 : v2.status;
    const v2Body: Json = v2.ok ? v2 : v2;
    const diffs = diffJson(canonicalize(v1.body), canonicalize(v2Body), [], COMMON_IGNORE_KEYS);
    results.push({
      surface: "records",
      status1: v1.status,
      status2: v2Status,
      diffs,
      shapeV1: summarizeShape(canonicalize(v1.body)),
      shapeV2: summarizeShape(canonicalize(v2Body)),
    });
  }

  // 5. module - first open requirement from v2 room.queue
  {
    const roomRes = await loadRoom(email, supa);
    const firstOpen = roomRes.ok
      ? roomRes.queue.find((q) => !q.signed && q.requirement_id)
      : null;
    if (!firstOpen) {
      results.push({
        surface: "module (SKIPPED: no open requirement)",
        status1: -1,
        status2: -1,
        diffs: [],
        shapeV1: "(n/a)",
        shapeV2: "(n/a)",
      });
    } else {
      const requirementId = String(firstOpen.requirement_id);
      const v1 = await runV1Handler({
        routeFile: "src/app/api/academy/module/[requirementId]/route.js",
        email,
        params: { requirementId },
      });
      const v2 = await loadModule(email, requirementId, supa);
      const v2Status = v2.ok ? 200 : v2.status;
      const v2Body: Json = v2.ok ? v2 : v2;
      // Module output: options[] is server-side-shuffled per request,
      // so array order on `questions[*].options` will NEVER match.
      // Compare the options array as a Set-equivalent (sort by id).
      // We do that by canonicalizing both before diff: sort each
      // options list by its id string.
      const sortOptions = (o: Json): Json => {
        if (!o || typeof o !== "object") return o;
        const obj = o as Record<string, unknown>;
        if (Array.isArray(obj.questions)) {
          obj.questions = (obj.questions as Array<Record<string, unknown>>).map((q) => {
            if (Array.isArray(q.options)) {
              const list = (q.options as Array<Record<string, unknown>>).slice();
              list.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
              q.options = list;
            }
            return q;
          });
        }
        return obj;
      };
      const v1Canon = sortOptions(canonicalize(v1.body));
      const v2Canon = sortOptions(canonicalize(v2Body));
      const diffs = diffJson(v1Canon, v2Canon, [], COMMON_IGNORE_KEYS);
      results.push({
        surface: "module",
        status1: v1.status,
        status2: v2Status,
        diffs,
        shapeV1: summarizeShape(v1Canon),
        shapeV2: summarizeShape(v2Canon),
      });
    }
  }

  // ─── print report ────────────────────────────────────────────
  console.log(`\n==== Academy parity: ${email} ====`);
  console.log(`v1 clone: ${v1Path}`);
  console.log(`DB: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
  for (const r of results) {
    console.log(`\n--- ${r.surface} ---`);
    console.log(`  status   v1=${r.status1}  v2=${r.status2}`);
    console.log(`  shape v1 ${r.shapeV1}`);
    console.log(`  shape v2 ${r.shapeV2}`);
    console.log(`  diffs (${r.diffs.length}):`);
    console.log(summarizeDiffs(r.diffs));
  }
  const anyDiff = results.some((r) => r.diffs.length > 0 || r.status1 !== r.status2);
  console.log(`\n==== ${anyDiff ? "DIFFS PRESENT" : "ZERO DIFFS"} ====\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parity] FATAL:", msg);
    process.exit(1);
  });
