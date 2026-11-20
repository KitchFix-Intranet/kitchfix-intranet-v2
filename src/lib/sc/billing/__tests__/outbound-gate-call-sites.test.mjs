// Grep guard: only ONE file in src/lib/sc/** may contain the
// literal `qbo_mode === "live"` (both quote styles), and that file
// is resolveQboMode.ts.
//
// Any other hit means a new file decided live/test on its own,
// outside the resolver, bypassing the SC_V2_OUTBOUND gate. That is
// a correctness bug and this test fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SC_ROOT = join(HERE, "..", "..");
const ALLOWED = ["submit/resolveQboMode.ts"];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      // Exclude __tests__ and __fixtures__ from the grep - they
      // may legitimately mention the pattern in strings.
      if (name === "__tests__" || name === "__fixtures__") continue;
      walk(p, out);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
    out.push(p);
  }
}

test("grep guard: only resolveQboMode.ts carries the live/test literal", () => {
  const files = [];
  walk(SC_ROOT, files);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/qbo_mode\s*===\s*["']live["']/.test(text)) {
      hits.push(relative(SC_ROOT, file));
    }
  }
  const unexpected = hits.filter((rel) => !ALLOWED.includes(rel));
  assert.deepEqual(
    unexpected, [],
    `Unexpected files contain \`qbo_mode === "live"\`. Only these are allowed: ${ALLOWED.join(", ")}`,
  );
  // Also assert the allowed file DOES carry it, so a rename doesn't
  // silently pass by removing the pattern from the one place that
  // owns the decision.
  assert.ok(
    hits.includes("submit/resolveQboMode.ts"),
    "resolveQboMode.ts must own the literal `qbo_mode === \"live\"`; the pattern is missing from it.",
  );
});
