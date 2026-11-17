// Type-debt counter for KPI engine train 2a.
//
// Walks the AST of every .ts file under src/lib/kpi/** (excluding
// proof/* and __tests__/*) and counts: `any` tokens, `as` casts,
// non-null `!` assertions, `@ts-expect-error` directives.
//
// Usage:
//   node --import tsx src/lib/kpi/proof/type_debt.mjs

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const V2_ROOT = "/Users/kevinfietek/dev/kpi-engine-2a-overview-move";
const ROOT = path.join(V2_ROOT, "src/lib/kpi");

function walkFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (name === "proof" || name === "__tests__") continue;
      walkFiles(full, out);
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function countOne(file) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
  const counts = { any: 0, as: 0, bang: 0, tsExpectError: 0 };
  // @ts-expect-error directives live in comment trivia, which the AST
  // doesn't surface as nodes. Count them from the raw source.
  counts.tsExpectError = (src.match(/@ts-expect-error/g) || []).length;

  function walk(node) {
    if (ts.isAsExpression(node)) counts.as++;
    if (ts.isNonNullExpression(node)) counts.bang++;
    if (node.kind === ts.SyntaxKind.AnyKeyword) counts.any++;
    ts.forEachChild(node, walk);
  }
  walk(sf);

  const lines = src.split("\n").length;
  return { lines, ...counts };
}

const files = walkFiles(ROOT).sort();
console.log("| file | lines | any | as | ! | @ts-expect-error |");
console.log("|---|--:|--:|--:|--:|--:|");
let totalLines = 0, totalAny = 0, totalAs = 0, totalBang = 0, totalXe = 0;
for (const f of files) {
  const c = countOne(f);
  const rel = path.relative(V2_ROOT, f);
  console.log(`| ${rel} | ${c.lines} | ${c.any} | ${c.as} | ${c.bang} | ${c.tsExpectError} |`);
  totalLines += c.lines;
  totalAny += c.any;
  totalAs += c.as;
  totalBang += c.bang;
  totalXe += c.tsExpectError;
}
console.log(`| **total** | ${totalLines} | ${totalAny} | ${totalAs} | ${totalBang} | ${totalXe} |`);
