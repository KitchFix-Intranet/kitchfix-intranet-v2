// Same-code measure for KPI engine train 2a.
//
// For each row of the port mapping: strip types from the V2 .ts file,
// drop comments + whitespace in both files, compare token by token
// with v1's original .js at the pin. Reports per file: tokens in v1,
// differing tokens, import-path vs other. "Other" must be 0 for every
// file moved whole, except overview/resolver.ts (the few tokens for
// the two regional-director display names, item 3 in the prompt).
//
// For partial-port files (roleGate, accountModels, rippling), the
// comparison runs on each brought-over declaration in isolation: the
// V2 body of a function is matched against v1's body of the same
// function. Non-brought declarations are ignored on the v1 side.
//
// Usage:
//   node --import tsx src/lib/kpi/proof/same_code.mjs <v1-root>
//
// Prints a plain-text report; hunks for every non-import difference.
// Exits 0 if the measure ran; non-zero on a read error. The expected
// numbers are checked by the reader.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const V1_ROOT = process.argv[2];
if (!V1_ROOT || !fs.existsSync(V1_ROOT)) {
  console.error("usage: same_code.mjs <v1-root>");
  process.exit(2);
}
const V2_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");

// Mapping: 27 whole files. v1 relative -> v2 relative.
const WHOLE = [
  ["src/app/kpi/labor/lib/board.js",            "src/lib/kpi/labor/board.ts"],
  ["src/app/kpi/labor/lib/periods.js",          "src/lib/kpi/labor/periods.ts"],
  ["src/app/kpi/purchasing/lib/board.js",       "src/lib/kpi/purchasing/board.ts"],
  ["src/app/kpi/purchasing/lib/resolver.js",    "src/lib/kpi/purchasing/resolver.ts"],
  ["src/lib/kpi/overview/accessFlags.js",       "src/lib/kpi/overview/accessFlags.ts"],
  ["src/lib/kpi/overview/billback.js",          "src/lib/kpi/overview/billback.ts"],
  ["src/lib/kpi/overview/budget-to-date.js",    "src/lib/kpi/overview/budget-to-date.ts"],
  ["src/lib/kpi/overview/flags.js",             "src/lib/kpi/overview/flags.ts"],
  ["src/lib/kpi/overview/formatting.js",        "src/lib/kpi/overview/formatting.ts"],
  ["src/lib/kpi/overview/pnl-loader.js",        "src/lib/kpi/overview/pnl-loader.ts"],
  ["src/lib/kpi/overview/resolver.js",          "src/lib/kpi/overview/resolver.ts"],
  ["src/lib/kpi/overview/revenue-source.js",    "src/lib/kpi/overview/revenue-source.ts"],
  ["src/lib/kpi/overview/ticker.js",            "src/lib/kpi/overview/ticker.ts"],
  ["src/lib/kpi/previewAccess.js",              "src/lib/kpi/previewAccess.ts"],
  ["src/lib/kpi/rangeSnap.js",                  "src/lib/kpi/rangeSnap.ts"],
  ["src/lib/kpi/resolveName.js",                "src/lib/kpi/resolveName.ts"],
  ["src/lib/kpi/resolveWorkerMeta.js",          "src/lib/kpi/resolveWorkerMeta.ts"],
  ["src/lib/kpi/shared/financeCloseAbsorb.js",  "src/lib/kpi/shared/financeCloseAbsorb.ts"],
  ["src/lib/kpi/shared/financeCloseAdjustment.js","src/lib/kpi/shared/financeCloseAdjustment.ts"],
  ["src/lib/kpi/shared/periodBasis.js",         "src/lib/kpi/shared/periodBasis.ts"],
  ["src/lib/labor/labor-week-basis.js",         "src/lib/kpi/labor/labor-week-basis.ts"],
  ["src/lib/labor/loaders.js",                  "src/lib/kpi/labor/loaders.ts"],
  ["src/lib/labor/personCount.js",              "src/lib/kpi/labor/personCount.ts"],
  ["src/lib/labor/salaryBoard.js",              "src/lib/kpi/labor/salaryBoard.ts"],
  ["src/lib/purchasing/glRollup.js",            "src/lib/kpi/purchasing/glRollup.ts"],
  ["src/lib/purchasing/loaders.js",             "src/lib/kpi/purchasing/loaders.ts"],
  ["src/lib/rippling/paginate.js",              "src/lib/kpi/shared/paginate.ts"],
  // Train 2c additions:
  ["src/app/kpi/purchasing/lib/precedence.js",  "src/lib/kpi/purchasing/precedence.ts"],
  ["src/lib/kpi/floors.js",                     "src/lib/kpi/floors.ts"],
  ["src/lib/kpi/portfolioMembers.js",           "src/lib/kpi/portfolioMembers.ts"],
  ["src/lib/labor/budgetProRate.js",            "src/lib/kpi/labor/budgetProRate.ts"],
  ["src/lib/labor/dailyRangeBody.js",           "src/lib/kpi/labor/dailyRangeBody.ts"],
  ["src/lib/labor/homestandResolver.js",        "src/lib/kpi/labor/homestandResolver.ts"],
  ["src/lib/labor/labor-batr.js",               "src/lib/kpi/labor/labor-batr.ts"],
  ["src/lib/labor/paySegmentDedupe.js",         "src/lib/kpi/labor/paySegmentDedupe.ts"],
  ["src/lib/labor/preFloorEstimator.js",        "src/lib/kpi/labor/preFloorEstimator.ts"],
  ["src/lib/labor/rangeResolver.js",            "src/lib/kpi/labor/rangeResolver.ts"],
  ["src/lib/labor/salaryProRate.js",            "src/lib/kpi/labor/salaryProRate.ts"],
  ["src/lib/labor/workerWeekRates.js",          "src/lib/kpi/labor/workerWeekRates.ts"],
];

// Train 2c: handler-to-entry mappings. v1's GET function body
// against v2's entry function. Compared with the same type-stripping
// pass; expected non-import diffs class as entry-shape, names,
// feeGoals, wiring, log, year, clock, paging, or comment-amount.
const MAPPED = [
  { v1: "src/app/api/kpi/labor/route.js",      v1Name: "GET", v2: "src/lib/kpi/entry.ts", v2Name: "getLabor" },
  { v1: "src/app/api/kpi/purchasing/route.js", v1Name: "GET", v2: "src/lib/kpi/entry.ts", v2Name: "getPurchasing" },
];

// Partial ports: v1 file -> v2 file + list of top-level declaration
// names that must be brought over. Only those are compared. Any other
// declaration in the v1 file is ignored.
const PARTIALS = [
  {
    v1: "src/lib/kpi/roleGate.js",
    v2: "src/lib/kpi/roleGate.ts",
    names: ["canViewAccount", "canSeeSalary", "landingAccount"],
  },
  {
    v1: "src/lib/accountModels.js",
    v2: "src/lib/kpi/accountModels.ts",
    names: ["costModelFor", "isKnownAccount", "PURCHASING_ENVELOPE_EXCLUSIONS"],
  },
  {
    v1: "src/lib/rippling.js",
    v2: "src/lib/kpi/shared/rippling.ts",
    names: ["isCardAuthorization"],
  },
];

// Strip types from a TS source string and return the resulting JS.
// `verbatimModuleSyntax` keeps every import / export token exactly as
// written - without it, TypeScript elides an imported name that is
// not referenced in the file body (board.js carries an unused
// `periodOf` import; v1's JS keeps it verbatim, so the stripped V2
// must too, or the measure fires a false non-import diff).
function stripTypes(src, fileName) {
  const out = ts.transpileModule(src, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
      isolatedModules: false,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: false,
  });
  return out.outputText;
}

// Normalise: parens around a single-identifier arrow parameter exist
// only to carry the type annotation; after type-stripping they are
// grammar-only. v1's style is unparenthesised `x =>`. Apply the same
// normalisation to BOTH sides of the comparison so v1 is untouched
// where it already lacks the parens, and the stripped V2 output
// loses the vestigial parens TypeScript's emit leaves behind.
// Only matches a single identifier followed by `)` then `=>`.
function normaliseArrowParens(src) {
  return src.replace(/\(\s*([A-Za-z_$][\w$]*)\s*\)(\s*=>)/g, "$1$2");
}

// TypeScript's emit normalises a trailing comma before a `)` away, so
// `foo(a, b,\n  )` strips to `foo(a, b);` even with verbatim module
// syntax. v1 keeps the trailing comma verbatim as JS. Apply the same
// normalisation to both sides so a purely stylistic trailing-comma
// difference does not count as a code diff.
function normaliseTrailingCommas(src) {
  return src.replace(/,(\s*)\)/g, "$1)");
}

// Tokenise a JS source string with ts.createScanner. Returns an array
// of { kind, text, pos, isImportFromString }. Whitespace and comment
// tokens are dropped. Template-literal substitutions are handled by
// re-scanning from the closing `}` of each ${...} so TemplateMiddle
// and TemplateTail come out as single tokens instead of collapsing
// everything after the first `}` into a bogus no-substitution literal.
function tokenise(src) {
  const sc = ts.createScanner(ts.ScriptTarget.ESNext, /*skipTrivia*/ true, ts.LanguageVariant.Standard, src);
  const toks = [];
  const importFromStringIdx = [];
  // Each entry: braces open inside the current template substitution.
  const templateStack = [];
  let tok;
  while (true) {
    tok = sc.scan();
    if (tok === ts.SyntaxKind.EndOfFileToken) break;
    // Skip trivia (skipTrivia=true already drops ws + newlines; keep
    // the check so a future flip of the flag does not silently break).
    if (
      tok === ts.SyntaxKind.WhitespaceTrivia ||
      tok === ts.SyntaxKind.NewLineTrivia ||
      tok === ts.SyntaxKind.SingleLineCommentTrivia ||
      tok === ts.SyntaxKind.MultiLineCommentTrivia
    ) continue;

    // Template-literal re-scan on `}` that closes a `${...}`.
    if (tok === ts.SyntaxKind.CloseBraceToken && templateStack.length) {
      const top = templateStack[templateStack.length - 1];
      if (top.braces === 0) {
        tok = sc.reScanTemplateToken(/*isTaggedTemplate*/ false);
        if (tok === ts.SyntaxKind.TemplateTail) templateStack.pop();
        // TemplateMiddle: stay on the stack with braces=0.
      } else {
        top.braces--;
      }
    } else if (tok === ts.SyntaxKind.OpenBraceToken && templateStack.length) {
      templateStack[templateStack.length - 1].braces++;
    } else if (tok === ts.SyntaxKind.TemplateHead) {
      templateStack.push({ braces: 0 });
    }

    const text = sc.getTokenText();
    toks.push({ kind: tok, text, pos: sc.getTokenStart() });

    // Mark the string literal that follows `from` (or stand-alone
    // `import "..."`) as an import-path string.
    const n = toks.length;
    if (n >= 2 && tok === ts.SyntaxKind.StringLiteral) {
      const prev = toks[n - 2];
      if (prev && (prev.kind === ts.SyntaxKind.FromKeyword || prev.kind === ts.SyntaxKind.ImportKeyword)) {
        importFromStringIdx.push(n - 1);
      }
    }
  }
  const importSet = new Set(importFromStringIdx);
  return toks.map((t, idx) => ({ ...t, isImportFromString: importSet.has(idx) }));
}

// Canonical token representation for the comparison. Uses the token
// text (not its kind) so e.g. identifiers compare by name, keywords
// by word, operators by text, strings by content.
function tok(t) { return t.text; }

// Diff two token streams with a tiny LCS-based algorithm, returning
// the list of hunks (each hunk is a contiguous block of mismatched
// tokens with context).
function diffTokens(a, b) {
  // Use Myers-style via LCS lengths. For files of ~10k tokens this is
  // O(n*m); acceptable here.
  const n = a.length, m = b.length;
  // If equal length and equal, shortcut.
  if (n === m) {
    let equal = true;
    for (let i = 0; i < n; i++) if (tok(a[i]) !== tok(b[i])) { equal = false; break; }
    if (equal) return { equal: true, hunks: [], aOnly: 0, bOnly: 0 };
  }
  // Compute LCS length table. Use Uint32Array per row to keep memory sane.
  const lcs = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (tok(a[i - 1]) === tok(b[j - 1])) lcs[i][j] = lcs[i - 1][j - 1] + 1;
      else lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }
  // Backtrack to emit ops.
  const ops = []; // { op: "equal"|"del"|"ins", a?, b? }
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (tok(a[i - 1]) === tok(b[j - 1])) { ops.push({ op: "equal", a: a[i - 1], b: b[j - 1] }); i--; j--; }
    else if (lcs[i - 1][j] >= lcs[i][j - 1]) { ops.push({ op: "del", a: a[i - 1] }); i--; }
    else { ops.push({ op: "ins", b: b[j - 1] }); j--; }
  }
  while (i > 0) { ops.push({ op: "del", a: a[i - 1] }); i--; }
  while (j > 0) { ops.push({ op: "ins", b: b[j - 1] }); j--; }
  ops.reverse();
  // Collapse runs of non-equal ops into hunks.
  const hunks = [];
  let run = null;
  for (const op of ops) {
    if (op.op === "equal") {
      if (run) { hunks.push(run); run = null; }
    } else {
      if (!run) run = { dels: [], inss: [] };
      if (op.op === "del") run.dels.push(op.a);
      else run.inss.push(op.b);
    }
  }
  if (run) hunks.push(run);
  let aOnly = 0, bOnly = 0;
  for (const h of hunks) { aOnly += h.dels.length; bOnly += h.inss.length; }
  return { equal: hunks.length === 0, hunks, aOnly, bOnly };
}

// For each hunk, classify: is every differing token an
// import-from-string literal? If so it is an "import-path"
// difference. Otherwise it is "other".
function classifyHunks(hunks) {
  const importHunks = [];
  const otherHunks = [];
  for (const h of hunks) {
    const allImports = (
      h.dels.every(t => t.isImportFromString) &&
      h.inss.every(t => t.isImportFromString)
    );
    if (allImports) importHunks.push(h);
    else otherHunks.push(h);
  }
  return { importHunks, otherHunks };
}

function formatHunk(h) {
  const d = h.dels.map(t => t.text).join(" ");
  const ii = h.inss.map(t => t.text).join(" ");
  const dLine = h.dels[0]?.pos ?? "?";
  const iLine = h.inss[0]?.pos ?? "?";
  return `  - v1 (@${dLine}): ${d || "<nothing>"}\n  + v2 (@${iLine}): ${ii || "<nothing>"}`;
}

// Extract the declaration named `name` from source. Walks the entire
// AST (not just top-level): roleGate.js defines canViewAccount /
// canSeeSalary / landingAccount as nested function declarations
// inside the loadRoleGate factory; in V2 they move to top-level, but
// on the v1 side we still need to find them where they sit.
//
// Prefers a FunctionDeclaration over a VariableStatement. roleGate.js
// has a local `const canSeeSalary = ...` inside loadRoleGate that
// would otherwise shadow the real function in a top-down walk.
//
// Also strips a leading `export` keyword from the returned substring
// so a brought function that is top-level-exported in V2 compares
// cleanly against a function that was private in v1. The `export`
// is a necessary consequence of the move, not a code change.
function extractTopDecl(src, fileName, name) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  let fn = null, vs = null;
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      if (!fn) fn = src.slice(node.pos, node.end);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          if (!vs) vs = src.slice(node.pos, node.end);
          break;
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  const out = fn || vs;
  if (!out) return null;
  return out.replace(/^(\s*)export\s+/, "$1");
}

// ---- Run the measure ----

const results = [];

for (const [v1Rel, v2Rel] of WHOLE) {
  const v1Abs = path.join(V1_ROOT, v1Rel);
  const v2Abs = path.join(V2_ROOT, v2Rel);
  if (!fs.existsSync(v2Abs)) {
    results.push({ kind: "whole", v1: v1Rel, v2: v2Rel, missing: true });
    continue;
  }
  const v1Src = fs.readFileSync(v1Abs, "utf8");
  const v2Src = fs.readFileSync(v2Abs, "utf8");
  const v2Stripped = stripTypes(v2Src, v2Abs);
  const v1Toks = tokenise(normaliseTrailingCommas(normaliseArrowParens(v1Src)));
  const v2Toks = tokenise(normaliseTrailingCommas(normaliseArrowParens(v2Stripped)));
  const d = diffTokens(v1Toks, v2Toks);
  const c = classifyHunks(d.hunks);
  results.push({
    kind: "whole", v1: v1Rel, v2: v2Rel,
    v1Tokens: v1Toks.length,
    v2Tokens: v2Toks.length,
    diffHunks: d.hunks.length,
    importHunks: c.importHunks.length,
    otherHunks: c.otherHunks,
    otherTokenCount: c.otherHunks.reduce((n, h) => n + h.dels.length + h.inss.length, 0),
    importTokenCount: c.importHunks.reduce((n, h) => n + h.dels.length + h.inss.length, 0),
  });
}

for (const p of PARTIALS) {
  const v1Abs = path.join(V1_ROOT, p.v1);
  const v2Abs = path.join(V2_ROOT, p.v2);
  if (!fs.existsSync(v2Abs)) {
    results.push({ kind: "partial", v1: p.v1, v2: p.v2, missing: true });
    continue;
  }
  const v1Src = fs.readFileSync(v1Abs, "utf8");
  const v2Src = fs.readFileSync(v2Abs, "utf8");
  const v2Stripped = stripTypes(v2Src, v2Abs);
  const perName = [];
  for (const name of p.names) {
    const v1Decl = extractTopDecl(v1Src, v1Abs, name);
    const v2Decl = extractTopDecl(v2Stripped, v2Abs, name);
    if (!v1Decl || !v2Decl) {
      perName.push({ name, missing: !v1Decl ? "v1" : "v2" });
      continue;
    }
    const v1Toks = tokenise(normaliseArrowParens(v1Decl));
    const v2Toks = tokenise(normaliseArrowParens(v2Decl));
    const d = diffTokens(v1Toks, v2Toks);
    const c = classifyHunks(d.hunks);
    perName.push({
      name,
      v1Tokens: v1Toks.length,
      v2Tokens: v2Toks.length,
      diffHunks: d.hunks.length,
      importHunks: c.importHunks.length,
      otherHunks: c.otherHunks,
      otherTokenCount: c.otherHunks.reduce((n, h) => n + h.dels.length + h.inss.length, 0),
      importTokenCount: c.importHunks.reduce((n, h) => n + h.dels.length + h.inss.length, 0),
    });
  }
  results.push({ kind: "partial", v1: p.v1, v2: p.v2, perName });
}

// Train 2c: handler-to-entry MAPPED comparisons.
for (const m of MAPPED) {
  const v1Abs = path.join(V1_ROOT, m.v1);
  const v2Abs = path.join(V2_ROOT, m.v2);
  if (!fs.existsSync(v2Abs)) {
    results.push({ kind: "mapped", v1: m.v1, v2: m.v2, missing: true });
    continue;
  }
  const v1Src = fs.readFileSync(v1Abs, "utf8");
  const v2Src = fs.readFileSync(v2Abs, "utf8");
  const v2Stripped = stripTypes(v2Src, v2Abs);
  const v1Decl = extractTopDecl(v1Src, v1Abs, m.v1Name);
  const v2Decl = extractTopDecl(v2Stripped, v2Abs, m.v2Name);
  if (!v1Decl || !v2Decl) {
    results.push({ kind: "mapped", v1: m.v1, v2: m.v2, v1Name: m.v1Name, v2Name: m.v2Name, missing: !v1Decl ? "v1" : "v2" });
    continue;
  }
  const v1Toks = tokenise(normaliseTrailingCommas(normaliseArrowParens(v1Decl)));
  const v2Toks = tokenise(normaliseTrailingCommas(normaliseArrowParens(v2Decl)));
  const d = diffTokens(v1Toks, v2Toks);
  const c = classifyHunks(d.hunks);
  results.push({
    kind: "mapped", v1: m.v1, v2: m.v2, v1Name: m.v1Name, v2Name: m.v2Name,
    v1Tokens: v1Toks.length,
    v2Tokens: v2Toks.length,
    diffHunks: d.hunks.length,
    importHunks: c.importHunks.length,
    otherHunks: c.otherHunks,
    otherTokenCount: c.otherHunks.reduce((n, h) => n + h.dels.length + h.inss.length, 0),
    importTokenCount: c.importHunks.reduce((n, h) => n + h.dels.length + h.inss.length, 0),
  });
}

// Print the report.
let totalV1 = 0, totalDiff = 0, totalImport = 0, totalOther = 0;
console.log("SAME-CODE MEASURE");
console.log("v1 root:", V1_ROOT);
console.log("");
console.log("WHOLE FILES");
console.log("-----------");
for (const r of results.filter(x => x.kind === "whole")) {
  if (r.missing) {
    console.log(`${r.v2}: MISSING (not yet ported)`);
    continue;
  }
  const expected = r.otherTokenCount === 0 || (r.v2.endsWith("overview/resolver.ts") && r.otherTokenCount > 0);
  const mark = r.otherTokenCount === 0 ? "ok" : (r.v2.endsWith("overview/resolver.ts") ? "ok (resolver RD exception)" : "**NON-IMPORT DIFF**");
  console.log(`${r.v2}`);
  console.log(`  v1-tokens: ${r.v1Tokens}  v2-tokens: ${r.v2Tokens}  diff-hunks: ${r.diffHunks}  import-hunks: ${r.importHunks}  other-tokens: ${r.otherTokenCount} [${mark}]`);
  if (r.otherHunks.length) {
    for (const h of r.otherHunks) console.log(formatHunk(h));
  }
  totalV1 += r.v1Tokens;
  totalDiff += r.v1Tokens === r.v2Tokens ? 0 : Math.abs(r.v1Tokens - r.v2Tokens);
  totalImport += r.importTokenCount;
  totalOther += r.otherTokenCount;
}
console.log("");
console.log("PARTIAL FILES");
console.log("-------------");
for (const r of results.filter(x => x.kind === "partial")) {
  console.log(`${r.v2}  <-  ${r.v1}`);
  if (r.missing) { console.log("  MISSING (not yet ported)"); continue; }
  for (const n of r.perName) {
    if (n.missing) {
      console.log(`  ${n.name}: MISSING in ${n.missing}`);
      continue;
    }
    const mark = n.otherTokenCount === 0 ? "ok" : "**NON-IMPORT DIFF**";
    console.log(`  ${n.name}: v1-tokens=${n.v1Tokens} v2-tokens=${n.v2Tokens} import-hunks=${n.importHunks} other-tokens=${n.otherTokenCount} [${mark}]`);
    if (n.otherHunks.length) {
      for (const h of n.otherHunks) console.log(formatHunk(h));
    }
    totalV1 += n.v1Tokens;
    totalImport += n.importTokenCount;
    totalOther += n.otherTokenCount;
  }
}

console.log("");
console.log("ENTRIES (handler-to-entry)");
console.log("--------------------------");
for (const r of results.filter(x => x.kind === "mapped")) {
  if (r.missing === true) { console.log(`${r.v2}: MISSING`); continue; }
  if (r.missing) { console.log(`${r.v2Name} in ${r.v2}: declaration missing in ${r.missing}`); continue; }
  const mark = r.otherTokenCount === 0 ? "ok" : "**NON-IMPORT DIFF**";
  console.log(`${r.v2Name} in ${r.v2}  <-  ${r.v1Name} in ${r.v1}`);
  console.log(`  v1-tokens: ${r.v1Tokens}  v2-tokens: ${r.v2Tokens}  diff-hunks: ${r.diffHunks}  import-hunks: ${r.importHunks}  other-tokens: ${r.otherTokenCount} [${mark}]`);
  if (r.otherHunks.length) {
    for (const h of r.otherHunks.slice(0, 20)) console.log(formatHunk(h));
    if (r.otherHunks.length > 20) console.log(`  ... (${r.otherHunks.length - 20} more hunks)`);
  }
  totalV1 += r.v1Tokens;
  totalImport += r.importTokenCount;
  totalOther += r.otherTokenCount;
}

console.log("");
console.log("TOTALS");
console.log("------");
console.log(`v1 tokens compared: ${totalV1}`);
console.log(`import-path differing tokens: ${totalImport}`);
console.log(`other differing tokens: ${totalOther}`);
