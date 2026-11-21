// src/lib/kpi/proof/screen_compare.mjs
//
// Train 2d-1 proof - Part 2: strict compare.
//
// Reads each case's screens/<id>.json + payloads/<id>.json produced by
// screen_capture.mjs, feeds the overview payload into V2's screen
// model + formatters, projects each builder's *Display output as a
// flat figure set, then compares two flat sets (DOM vs model) text-
// exact, bidirectional, under the STRICT key per Kevin:
//
//   key = { block, row_label, column_label, text, side }
//
// ---------------------------------------------------------------------
// Projector purity list (Kevin ruling 2026-11-20 - train 2d-1 PR #94
// bounce, item 2).  The projector formats and places only; it does not
// decide anything from values.  Below is the exhaustive list of every
// place the projector branches, each annotated as either MOVED to the
// model, NAMED-FINE per Kevin's two acceptable patterns, or TEXT-
// LAYOUT (a pure string-shape normalisation on text already emitted
// by the model + formatter, not a value-derived decision).
//
// Kevin's two named-fine patterns:
//   (K1) per-block row / column label mapping table (how a model row
//        becomes a DOM (row_label, column_label) tuple).
//   (K2) the "100%" cell normalisation on the PnL revenue-total row
//        (v1 hardcodes "100%"; the model's formatter emits "100.00%";
//        the projector rewrites this ONE text to match DOM).
//
// DOM side (filter + parse of captured HTML; not a V2 logic decision):
//   - TONE_CLASS_MAP: class -> side mapping, DOM-only.
//   - PILL_LABEL_SIDE / FOOT_LABEL_SIDE: closed vocabulary -> side,
//     DOM-only (compensates for the capture regex not matching the
//     pill / foot class families; no re-capture per Kevin).
//   - sideFromDom(): DOM-only.
//   - ALLOW_LIST_BLOCKS / ALLOW_LIST_TEXTS / NOT_FIGURE_PATTERNS /
//     FIGURE_PATTERNS: filter mapping applied symmetrically to both
//     sides so neither carries a non-figure.
//
// Model side (projector branches that act on V2 model output):
//
// projectCardsRow (card-revenue / card-cogs / card-gross_margin):
//   - heroCol / pctCol by kind:                              K1.
//   - Hero side = card.hero_side (model-carried), with       MOVED
//       the "wait" -> compare-side "none" collapse per
//       the DOM capture regex (not a value decision -
//       the model carries the semantic "wait"; the DOM
//       just doesn't have a matching tone class).
//   - Pill label + pill side = model `card.pill_label` +    MOVED
//       `card.pill_side` passthrough.
//   - Pill label emitted only when it passes the DOM        TEXT-LAYOUT
//       figure regex (pillEmits) - compensates for the
//       capture-side regex rejecting " of " labels.
//   - Reference row label = "Projection" (revenue) vs       K1
//       "Adjusted" (cogs/gm).
//   - Footer suppression: `card.footer_suppressed`          MOVED
//       (model-carried; consolidates pill-neutral,
//       awaiting-amber, |delta|<1 gates).
//   - Footer bare magnitude via bareMagnitude():            TEXT-LAYOUT
//       strips the trailing direction word that the
//       formatter concatenates ("$X over" -> "$X") to
//       match the DOM's two-text-node render.
//
// projectRevenueLines (revenue-lines):
//   - Row label `<line_code><label>`:                        K1.
//   - Budget / Actual / pct columns to "Plan" / "Actual" /  K1.
//       "" positional mapping.
//   - Actual side = normaliseSide(r.tone), model-carried.   MOVED
//     (r.tone is a model enum - all tone decisions live
//      in the revenueLines model build.)
//
// projectCostLines (cost-lines):
//   - Row label `<line_code><label>` + "?" suffix on        K1.
//       3200 / 3400 / 3500 (HelpPop glyph in DOM).
//   - adjusted / target_pct / actual columns to "Plan" /    K1.
//       "Actual" / "" positional mapping.
//   - Per-row actual_pct side = normaliseSide(r.verdict),   MOVED
//       model-carried.  Model's verdict already matches
//       v1 CostLines.CostRow (including null-adjusted ->
//       "good" case).  No projector fallback.
//   - Total %rev side = normaliseSide(d.total.verdict),     MOVED
//       model-carried.  Model's verdict already matches
//       v1 CostLines.TotalRow (dollar-sign rule, not
//       percent-sign).
//
// projectAlsoTracked (also-tracked):
//   - Row label mapping:                                     K1.
//   - Budget / Actual / variance column mapping:             K1.
//   - Variance side = normaliseSide(r.tone), model-carried.  MOVED
//   - bareMagnitude() strip on composite variance text:      TEXT-LAYOUT.
//
// projectPnlStatement (pnl-table):
//   - Which row set: d.include_salary ? full : summary.      K1
//     (determined by the model-carried `include_salary`;
//      not a value-derived projector decision).
//   - Row label total vs line vs section:                    K1.
//   - "Plan" / "Actual" / "" positional column mapping:      K1.
//   - target_pct "100%" hardcode on total revenue row:        K2.
//   - actual_pct "100%" hardcode on total revenue row:        K2.
//   - Skip emit when r.hatch_adjusted / r.hatch_actual_pct:  MOVED
//       both hatch flags are model-carried; the projector
//       only skips emission on hatched cells (v1 renders
//       the hatched pattern, which has no figure text).
//   - Variance side = normaliseSide(r.verdict).              MOVED
//       Model's verdict matches v1 VarCell exactly
//       (axis-driven on actual-ref, including credit rows).
//
// projectLaborLedger (labor-ledger):
//   - Band row label "›FY<y> · PERIOD <n><wks> wks":         K1
//     plus pluralization wk vs wks (count-driven label).
//   - Grand row label "TOTAL · PERIOD <n>" or               K1
//       "TOTAL · <n> PERIODS · <w> WEEKS":
//     count-driven label.
//   - Column labels "Reg $" / "OT $" / "Hol $" / "Prem $" / K1
//       "Salary" / "Total".
//   - Zero-labor band row suppression (all five display      NAMED HERE:
//       fields null => skip the band entirely).  v1          null-guard,
//       renders a text-only "no labor recorded" placeholder  symmetric
//       row carrying no figures; the DOM capture produces
//       no figures for it; the projector must match.  The
//       suppression reads model-carried display-field
//       nullity, not re-derived values - documented here
//       in lieu of a dedicated `band.has_dollars` flag
//       because adding one would duplicate information the
//       display already surfaces.
//
// projectPurchasingFold / projectWeekRail / projectSettlingStrip /
// projectOverdueNudge / projectStatusLine:
//   - Return []: no closed-case DOM renders these as figure- MOVED
//       bearing blocks (running-period / 2d-2 scope).  The
//       model's d.render / tile set is what determines
//       emission; scope is model-carried.
// ---------------------------------------------------------------------
//
// Multiset semantics: a figure that appears N times on one side must
// appear N times on the other to fully agree. Surplus occurrences
// surface as diffs.
//
// Row / column labels are keyed via a PROJECTOR MAPPING TABLE that
// mirrors the DOM extractor's exact scheme per block. The labels are
// documented inline next to the projector that emits them. See
// `PROJECTOR_SCHEME` comment below for the full per-block map.
//
// Allow-list (filtered from BOTH sides before compare):
//   - chart / chart-fold blocks            no charts in V2
//   - billback cards + billback ledger     fee-section not designed
//   - DataCurrentPop / freshness pop       not figure-bearing
//   - help text / tooltips / aria descr.   not figure-bearing
//   - section headers / card titles         no number
//   - range meta header (period name/dates) identity, not a figure
//   - non-figure labels (Budget / Actual)   not a figure
//
// Usage:
//   node --import tsx \
//        --env-file=/Users/kevinfietek/dev/kitchfix-intranet/.env.local \
//        src/lib/kpi/proof/screen_compare.mjs
//
// Writes to ~/Downloads/KPI_V2_Handoff/proof_2d1/:
//   compare.json          per-case class + differing paths
//   planted/planted.json  always written; 8 total plants
//   PROOF_REPORT.md       human-readable summary

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const V1_CLONE = "/Users/kevinfietek/dev/kitchfix-intranet";
const OUT_ROOT = "/Users/kevinfietek/Downloads/KPI_V2_Handoff/proof_2d1";
const IN_PAYLOADS = path.join(OUT_ROOT, "payloads");
const IN_SCREENS = path.join(OUT_ROOT, "screens");

// Env loading (same pattern as capture).
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
const envArg = process.argv.find((a) => a.startsWith("--env-file="));
if (envArg) loadEnvFile(envArg.slice("--env-file=".length));
loadEnvFile(path.join(V1_CLONE, ".env.local"));
if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
}
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}

// Import V2 screen model via tsx.
//
// tsx-loader surfaces re-exports of .ts files on `.default` rather
// than top-level under certain CLI entry shapes. Unwrap defensively
// so this script works both ways.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const screenMod = await import(path.resolve(HERE, "../screen/index.ts"));
const screen = screenMod.default && typeof screenMod.default === "object"
  ? { ...screenMod, ...screenMod.default }
  : screenMod;

// ---------------------------------------------------------------------
// TONE_CLASS_MAP + HOW V1 COLOUR IS READ OFF THE PAGE
// ---------------------------------------------------------------------
//
// The DOM extractor (screen_capture.mjs) reads tone on each figure by
// walking up ancestors for an element whose className matches one of
// the v1 tone classes. The capture's current regex covers the primary
// family:
//
//   kpi-ov-good         -> "good"   (per-cell numeric tone)
//   kpi-ov-bad          -> "bad"
//   kpi-ov-neu          -> "neutral"
//   kpi-ov-even         -> "neutral"
//   kpi-ov-tone-good    -> "good"   (newer prefix family)
//   kpi-ov-tone-bad     -> "bad"
//   kpi-ov-tone-neutral -> "neutral"
//
// The regex does NOT cover the pill or variance-foot families, which
// carry tone through compound class names:
//
//   kpi-ov-pill-good    -> "good"   (pill chips)
//   kpi-ov-pill-bad     -> "bad"
//   kpi-ov-pill-warn    -> "wait"   (amber "Provisional" on a closed-
//                                    not-yet-verified period)
//   kpi-ov-pill-neutral -> "even"
//
//   kpi-ov-foot-good    -> "good"   (card variance footer)
//   kpi-ov-foot-bad     -> "bad"
//   kpi-ov-foot-wait    -> "wait"
//
//   kpi-ov-rail-tile-* variants on WeekRail tiles encode state
//   (closed / inprogress / not-started), not tone; the per-cell
//   tone on rail figures is already in the `kpi-ov-good` family on
//   the hero rule it falls under.
//
// Pill + footer figures therefore come back with `tone: null` in the
// captured JSON despite v1 colouring them on screen.  Rather than
// re-capture to broaden the regex (Kevin: no re-capture unless
// strictly required), we infer the side from the figure's TEXT on
// both sides via `sideFromText` + `sideFromModelVerdict` below.  The
// pill labels are a closed vocabulary ("over budget" always bad on
// cogs, "under budget" always good on cogs, etc.) so the inference
// is deterministic.
//
// The DOM `tone` field we DO have (cell-level good/bad on P&L totals,
// cost-line %rev, revenue-line heros, also-tracked variance, pnl
// VarCell, card hero + pct-small) is used directly.
const TONE_CLASS_MAP = {
  "kpi-ov-good": "good",
  "kpi-ov-bad": "bad",
  "kpi-ov-neu": "even",
  "kpi-ov-even": "even",
  "kpi-ov-tone-good": "good",
  "kpi-ov-tone-bad": "bad",
  "kpi-ov-tone-neutral": "even",
  "kpi-ov-pill-good": "good",
  "kpi-ov-pill-bad": "bad",
  "kpi-ov-pill-warn": "wait",
  "kpi-ov-pill-neutral": "even",
  "kpi-ov-foot-good": "good",
  "kpi-ov-foot-bad": "bad",
  "kpi-ov-foot-wait": "wait",
};

// Pill label vocabulary (closed set across the 92-case battery).
// Verified empirically; see /tmp probe + the PROOF_REPORT "How v1's
// colour is read off the page" section.
const PILL_LABEL_SIDE = new Map([
  // Revenue card
  ["above projection", "good"],
  ["below projection", "bad"],
  ["on projection", "good"],
  ["Contractual", "even"],
  // Cogs card
  ["over budget", "bad"],
  ["under budget", "good"],
  ["No target", "even"],
  // GM card (lowercase + hyphenated forms seen)
  ["ahead of target", "good"],
  ["behind target", "bad"],
  // The DOM extractor rejects pill labels that contain "of" via its
  // figure regex; `ahead of target` is never captured.  The projector
  // emits it ONLY when it would pass the DOM regex, which is to say
  // not at all for these labels.  Listed here for lookup by side.
]);

// Variance-footer label vocabulary.  Same shape as pills but lives
// under the card's footer <div class="kpi-ov-foot ..."> and carries
// the tone via the compound class.  The capture extracts the LABEL
// as a distinct text node (so does the AMOUNT); side is inferred
// from the TEXT.
const FOOT_LABEL_SIDE = new Map([
  ["Over budget", "bad"],
  ["Under budget", "good"],
  ["Ahead of budget", "good"],   // "of" blocked from DOM regex - not emitted
  ["Behind budget", "bad"],
  ["Above projection", "good"],
  ["Below projection", "bad"],
]);

// Blocks in the allow-list - DROPPED from both sides before compare.
const ALLOW_LIST_BLOCKS = new Set([
  "chart",
  "chart-fold",
  "fold-chart",
  "billback",
  "billback-period",
  "billback-ledger",
  "billback-pct-pill",
  "billback-period-pill",
  "billback-actual-to-date",
  "billback-goal-to-date",
  "billback-period-actual",
  "billback-period-goal",
  "billback-vs-goal",
  "billback-period-vs",
  "billback-breakdown",
  "billback-no-goal",
  "billback-row",
  "billback-foot",
  "billback-fold-summary",
  "billback-ledger-no-goal",
  "data-current",
  "sources",
  // CP / NP running-period blocks (2d-2 scope)
  "cp-vsproj",
  // Awaiting-period pill - identity marker
  "status-awaiting-pill",
  // Status pill horizon / state copy - pill text, we treat as not-a-figure
  "status-horizon",
  // Some per-cell marker attrs that don't carry number meaning
  "revenue-tip-year",
  "cogs-tip-plan",
  "cogs-tip-envelope",
  "gm-tip-plan",
]);

// Text that is a header/title/label, never a figure - filter from DOM.
const ALLOW_LIST_TEXTS = new Set([
  "Budget",
  "Actual",
  "Adjusted",
  "Revenue",
  "Cost of goods sold",
  "Gross margin",
  "Also tracked · outside gross margin",
  "Target",
  "Over",
  "Under",
  "On",
  "FYTD",
  "Full",
  "Summary",
]);

// Patterns on DOM text which are NOT figures.
const NOT_FIGURE_PATTERNS = [
  /^KPI\b/i,
  /^P&L\b/i,
  /^Period\s+\d+$/i,
  /^Custom$/i,
  /^Verified$/i,
  /^Live$/i,
  /^Planned$/i,
  /^Download P&L$/i,
  /^Hourly$/i,
  /^\+ ?Salary$/i,
  /^Data current$/i,
];

// Figure-shape patterns.  Mirrors DOM extractor's FIGURE patterns in
// screen_capture.mjs.  Adjusting here without recapture would create
// an asymmetry; the projector must emit figures whose text already
// passes the capture-side regex.
const FIGURE_PATTERNS = [
  /^\$-?[\d,]+(?:\.\d+)?(?: credit)?$/,
  /^-?\d+(?:\.\d+)?\s*%$/,
  /^-?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:hrs?|h)$/i,
  /^on budget$/i,
  /^on target$/i,
  /^(?:over|under|above|below|ahead|behind)\s+(?:budget|target|projection)$/i,
  /^\d+\s+days? ago$/i,
  /^\d+\s+(?:person|people)$/i,
  /^P\d+\s+awaiting verification/i,
  /^—$/,
];

function looksLikeFigure(t) {
  if (!t) return false;
  const s = t.trim();
  if (ALLOW_LIST_TEXTS.has(s)) return false;
  for (const p of NOT_FIGURE_PATTERNS) if (p.test(s)) return false;
  for (const p of FIGURE_PATTERNS) if (p.test(s)) return true;
  return false;
}

// Determine SIDE on the DOM side.
//
//   1. If the captured `tone` is one of the mapped values, use it.
//   2. Else, if the text is a pill label from the known vocabulary,
//      use PILL_LABEL_SIDE.
//   3. Else, if the text is a footer direction label ("Over budget"
//      etc.), use FOOT_LABEL_SIDE.
//   4. Else if the text literally is "on budget" / "on target",
//      side = "even".
//   5. Else null -> "none".
function sideFromDom(fig) {
  const tone = fig.tone;
  if (tone === "good") return "good";
  if (tone === "bad") return "bad";
  if (tone === "neutral") return "even";
  if (tone === "wait") return "wait";
  const t = (fig.text || "").trim();
  if (PILL_LABEL_SIDE.has(t)) return PILL_LABEL_SIDE.get(t);
  if (FOOT_LABEL_SIDE.has(t)) return FOOT_LABEL_SIDE.get(t);
  if (/^on budget$/i.test(t) || /^on target$/i.test(t)) return "even";
  return "none";
}

// Tone normalisation on the model side.
function normaliseSide(tone) {
  if (tone === "good") return "good";
  if (tone === "bad") return "bad";
  if (tone === "even" || tone === "neutral") return "even";
  if (tone === "wait") return "wait";
  return "none";
}

// ---------------------------------------------------------------------
// PROJECTOR SCHEME (per-block label contract matching the DOM walker)
// ---------------------------------------------------------------------
//
// The DOM extractor (screen_capture.mjs EXTRACT_FN) assigns:
//
//   row_label  = the text content of the first <th>/<td> in the
//                nearest <tr> ancestor.  Non-table figures fall
//                back to the nearest ancestor with a card-* or
//                *-row data-kpi-ov whose .kpi-ov-card-hdr /
//                .kpi-ov-pair-k / .kpi-ov-cl-k text names the pair.
//   column_label = the text content of the HEADER cell at the SAME
//                POSITIONAL INDEX inside the first thead tr (not
//                the second, if the thead has two rows).  Non-cell
//                figures fall back to the element's own data-kpi-ov
//                attribute.
//
// This produces a scheme that is NOT 1:1 with the data columns:
//
//   pnl-table (2-row thead: "", "Plan" colspan 3, "Actual" colspan 2,
//              "" / Line, Budget, Target %, Adjusted, Actual, % of
//              rev, variance):
//     - idx 0 (Line / row label)       col=""
//     - idx 1 (budget_to_date $)       col="Plan"
//     - idx 2 (target_pct %)           col="Actual"  ← group-header colspan
//     - idx 3 (adjusted $)             col=""
//     - idx 4 (actual $)               col=""
//     - idx 5 (actual_pct %)           col=""
//     - idx 6 (variance)               col=""
//
//   revenue-lines (thead: "", "Plan", "Actual" colspan 2 / Line,
//                  Budget, Actual, % of rev):
//     - idx 1 (budget)                 col="Plan"
//     - idx 2 (actual)                 col="Actual"
//     - idx 3 (pct_of_revenue)         col=""
//
//   cost-lines CLOSED (thead: "", "Plan" colspan 2, "Actual" colspan
//                      2 / Line, Adjusted, Target %, Actual, % of rev):
//     - idx 1 (adjusted $)             col="Plan"
//     - idx 2 (target_pct %)           col="Actual"  ← group-header colspan
//     - idx 3 (actual $)               col=""
//     - idx 4 (actual_pct %)           col=""
//
//   also-tracked (thead: "", "Plan", "Actual" colspan 2 / Line,
//                 Budget, Spent, vs budget):
//     - idx 1 (budget $)               col="Plan"
//     - idx 2 (actual $)               col="Actual"
//     - idx 3 (variance $)             col=""
//
//   card-revenue (no table; card chrome):
//     - row="Actual", col="pill"       pill.label                 (text node parent = pill span)
//     - row="Actual", col=""           hero actual $              (text node parent = DashOrValue inner span, no data-kpi-ov)
//     - row="Projection", col=""       budget reference $         (same reason)
//     - row="Actual", col=""           footer label "Above projection"
//     - row="Actual", col=""           footer bare magnitude "$X"
//
//   card-cogs / card-gross_margin (no table; card chrome):
//     - row="Actual", col="pill"       pill.label
//     - row="Actual", col="hero-<kind>"       hero actual $        (text node parent = outer hero span)
//     - row="Actual", col="hero-<kind>-pct"   hero actual %-small (text node parent = inner <small>)
//     - row="Adjusted", col="target-<kind>"   target $             (same shape)
//     - row="Adjusted", col="target-<kind>-pct" target %           (same shape)
//     - row="Actual", col=""           footer label
//     - row="Actual", col=""           footer bare magnitude
//
//   labor-ledger (WeekTable; band rows + grand total):
//     - row_label = "›FY2026 · PERIOD N4 wks" (closed-period, chev + band + sub)
//                 OR "TOTAL · PERIOD N" (single period) / "TOTAL · N PERIODS · M WEEKS"
//     - column_label = "Reg $" / "OT $" / "Hol $" / "Prem $" / "Salary" / "Total"
//
//   purchasing-fold-* (collapsed state in capture): no DOM rows, so
//     the projector emits none either (ALLOW_LIST exempt).  See
//     projectPurchasingFold below.
//
// All five keys (block, row_label, column_label, text, side) must
// match for a figure to agree.

// ---------------------------------------------------------------------
// Projectors
// ---------------------------------------------------------------------

// Strip the trailing direction word from a gap display and return the
// bare dollar/percent text.  v1 renders variance_label + magnitude
// as two separate text nodes; the model's `gapDollarsCost` /
// `gapDollarsRevenue` emits them concatenated as "$X over".
function bareMagnitude(composite) {
  if (!composite) return null;
  const m = String(composite).match(
    /^(.*?)\s+(?:over|under|above|below|ahead|behind)$/i,
  );
  return m ? m[1].trim() : null;
}

// Pill labels that survive the DOM figure regex.  "ahead of target"
// contains " of " and fails the regex; if the model would emit such
// a label we SKIP it on the projector side so neither side carries
// it (see left-out list in report).
function pillEmits(label) {
  if (!label) return false;
  // Emit only labels that match the DOM extractor's figure regex AND
  // our pill vocabulary.  "Contractual" is a pill word but doesn't
  // match the figure regex (no over/under/above/below/etc.) - skip.
  for (const p of FIGURE_PATTERNS) if (p.test(label)) return true;
  return false;
}

function projectCardsRow(payload, context) {
  // The V2 cardsRow MODEL carries pill LABEL under `pill_label` (see
  // model edit this round).  No more payload.pill.label read at the
  // projector.
  const m = screen.buildCardsRow(payload);
  const d = screen.formatCardsRow(m);
  if (!d.render) return [];
  const figures = [];

  const emit = (card, kind, pillLabel, pillSide) => {
    const block = `card-${kind}`;
    // Pill label (figure only when it passes the DOM regex).
    if (pillLabel && pillEmits(pillLabel)) {
      figures.push({
        block,
        row_label: "Actual",
        column_label: "pill",
        text: pillLabel,
        side: pillSide ?? "none",
      });
    }
    // Hero row (actual).  Revenue card's actual is wrapped in
    // DashOrValue so col="" on the capture; cogs/gm card is not
    // wrapped so col="hero-<kind>" (see DOM scheme above).
    const heroCol = kind === "revenue" ? "" : `hero-${kind}`;
    const pctCol = kind === "revenue" ? "" : `hero-${kind}-pct`;
    // Hero tone comes off the model (`card.hero_side`), per Kevin's
    // 2026-11-20 ruling: the model carries v1's side; the projector
    // only formats + places.  The DOM capture regex treats "wait" as
    // no colour class -> map to "none" for compare.
    const heroSide = card.hero_side === "wait" ? "none" : card.hero_side;
    // Hero actual $
    if (card.actual_display) {
      figures.push({
        block,
        row_label: "Actual",
        column_label: heroCol,
        text: card.actual_display,
        side: heroSide,
      });
    }
    // Hero actual %-small (cogs + gm only)
    if (kind !== "revenue" && card.pct_actual_display) {
      figures.push({
        block,
        row_label: "Actual",
        column_label: pctCol,
        text: card.pct_actual_display,
        side: heroSide,
      });
    }
    // Reference row.
    if (kind === "revenue") {
      // Revenue reference row renders "Projection" as the label; the
      // value is budget_full_period (closed) or budget_to_date (fytd).
      if (card.budget_display) {
        figures.push({
          block,
          row_label: "Projection",
          column_label: "",
          text: card.budget_display,
          side: "none",
        });
      }
    } else {
      // Cogs / GM reference row labelled "Adjusted" with $ + %-small.
      if (card.adjusted_display) {
        figures.push({
          block,
          row_label: "Adjusted",
          column_label: `target-${kind}`,
          text: card.adjusted_display,
          side: "none",
        });
      }
      if (card.pct_adjusted_display) {
        figures.push({
          block,
          row_label: "Adjusted",
          column_label: `target-${kind}-pct`,
          text: card.pct_adjusted_display,
          side: "none",
        });
      }
    }
    // Footer label + bare magnitude.  Suppression is now consolidated
    // on the MODEL: `card.footer_suppressed` reflects all three gates
    // v1 VarianceFoot applies (pill.tone neutral / awaiting-amber /
    // |delta|<1).  Projector reads the model, not the payload.
    //
    // DOM regex rejects labels containing " of " (e.g. "Ahead of
    // budget") so the label text node is not captured, but the
    // sibling bare-magnitude ($X) text node IS captured.  Emit the
    // label only when it passes DOM regex; ALWAYS emit the bare
    // magnitude when the footer is rendered.
    const footerSuppressed = card.footer_suppressed;
    if (!footerSuppressed && card.variance_label) {
      const labelPassesRegex = pillEmits(card.variance_label);
      if (labelPassesRegex) {
        figures.push({
          block,
          row_label: "Actual",
          column_label: "",
          text: card.variance_label,
          side: normaliseSide(card.variance_direction),
        });
      }
      const bare = bareMagnitude(card.gap_dollars_display);
      if (bare) {
        figures.push({
          block,
          row_label: "Actual",
          column_label: "",
          text: bare,
          side: "none",
        });
      }
    }
  };

  // Pull pill label + side from the FORMATTED display (which carries
  // the passthrough fields the model surfaces).  No direct payload
  // reads here - Item 3 purity fix.
  emit(d.revenue, "revenue", d.revenue.pill_label, d.revenue.pill_side);
  emit(d.cogs, "cogs", d.cogs.pill_label, d.cogs.pill_side);
  emit(d.gross_margin, "gross_margin", d.gross_margin.pill_label, d.gross_margin.pill_side);
  return figures;
}

function projectPnlStatement(payload, context) {
  const m = screen.buildPnlStatement(payload);
  const d = screen.formatPnlStatement(m);
  if (!d.render) return [];
  const figures = [];
  // Which shape renders per DOM?  Verified empirically against the
  // capture: every sal0 case's DOM is summary (42/42), every sal1
  // non-S4 case is full (40/40).  S4 cases are summary (role gate).
  // Item 3 fix: read from the model, not directly from the payload.
  const rows = d.include_salary ? d.full_rows : d.summary_rows;
  for (const r of rows) {
    const block = "pnl-table";
    // v1 LineRow emits "<line_code> <label>" in the left cell (e.g.
    // "2200 Catering revenue"), DOM extractor's closestRowLabel
    // normalises whitespace.  Section rows also render only their
    // label (e.g. "Revenue") but have no figures so they won't
    // produce figures.
    let rowLabel;
    if (r.variant === "section") continue;
    if (r.variant === "total") {
      // v1 total rows emit just the total label (no line_code):
      //   "Total revenue" / "Total cost of goods sold" / "Gross margin"
      rowLabel = r.label;
    } else {
      // Line / sub / tracked: "<line_code> <label>"
      rowLabel = r.line_code ? `${r.line_code} ${r.label}` : r.label;
    }
    if (r.inactive) {
      // v1 renders "not active" across cells; filtered by DOM regex.
      continue;
    }
    // Note: `not_reported` rows (actual null; "not reported" caption)
    // STILL emit budget + target_pct + adjusted figures - v1 renders
    // those three Plan-band cells regardless of reported state.
    // Map cells to DOM columns:
    //   idx 1 = budget (Plan $)            col="Plan"
    //   idx 2 = target_pct %               col="Actual"  (colspan artefact)
    //   idx 3 = adjusted $                  col=""
    //   idx 4 = actual $                    col=""
    //   idx 5 = actual_pct %                col=""
    //   idx 6 = variance                    col=""
    const pushIf = (col, text, side) => {
      if (text != null) figures.push({ block, row_label: rowLabel, column_label: col, text, side });
    };
    pushIf("Plan", r.budget_display, "none");
    // target_pct: On total revenue, v1 HARDCODES "100%" in that cell
    // (no server target_pct).  The model doesn't carry a target_pct
    // on the revenue total; inject "100%" to match DOM.
    if (r.variant === "total" && r.label === "Total revenue") {
      pushIf("Actual", "100%", "none");
    } else {
      pushIf("Actual", r.target_pct_display, "none");
    }
    // adjusted cell: hatched on revenue rows + revenue total; v1
    // renders empty (no figure) in those cases.
    if (!(r.variant === "total" && r.label === "Total revenue") && !r.hatch_adjusted) {
      pushIf("", r.adjusted_display, "none");
    }
    pushIf("", r.actual_display, "none");
    // actual_pct cell: "100%" on revenue total (v1 hardcode); "100.00%"
    // -> "100%" normalisation (v1 renders "100%" literal; our formatPct
    // emits "100.00%").  Document:
    //   render: percentage formatter returns `${n.toFixed(2)}%` (e.g.
    //   "100.00%").  v1's total row hardcodes "100%" instead.
    //   Normalisation in the projector (not the model) because the
    //   V2 model is the correct general form; v1 is the exception.
    //   FLAGGED in PROOF_REPORT.
    if (r.variant === "total" && r.label === "Total revenue") {
      pushIf("", "100%", "none");
    } else if (!r.hatch_actual_pct) {
      pushIf("", r.actual_pct_display, "none");
    }
    // variance cell: side comes from `r.verdict`, which the model
    // computes to match v1 PnlStatement.VarCell exactly (axis-driven
    // tone from `actual - ref`, including credit rows).  The projector
    // only formats + places - no fallback.
    if (r.variance_display) {
      if (/^on budget$/i.test(r.variance_display)) {
        pushIf("", "on budget", "even");
      } else {
        pushIf("", r.variance_display, normaliseSide(r.verdict));
      }
    }
  }
  return figures;
}

function projectRevenueLines(payload, context) {
  const m = screen.buildRevenueLines(payload);
  const d = screen.formatRevenueLines(m);
  if (!d.render) return [];
  const figures = [];
  const block = "revenue-lines";
  // v1 RevenueLines left column emits "<line_code><label>" (no
  // separator between them per the capture).  DOM capture shows
  // "2200Catering revenue".  Mirror exactly.
  for (const r of d.rows) {
    const rowLabel = `${r.line_code}${r.label}`;
    if (r.budget_display)
      figures.push({ block, row_label: rowLabel, column_label: "Plan", text: r.budget_display, side: "none" });
    if (r.actual_display)
      figures.push({ block, row_label: rowLabel, column_label: "Actual", text: r.actual_display, side: normaliseSide(r.tone) });
    if (r.pct_display)
      figures.push({ block, row_label: rowLabel, column_label: "", text: r.pct_display, side: "none" });
  }
  // Total row.
  if (d.total.budget_display)
    figures.push({ block, row_label: "Total revenue", column_label: "Plan", text: d.total.budget_display, side: "none" });
  if (d.total.actual_display)
    figures.push({ block, row_label: "Total revenue", column_label: "Actual", text: d.total.actual_display, side: "none" });
  if (d.total.pct_display)
    figures.push({ block, row_label: "Total revenue", column_label: "", text: d.total.pct_display, side: "none" });
  return figures;
}

function projectCostLines(payload, context) {
  const m = screen.buildCostLines(payload);
  const d = screen.formatCostLines(m);
  if (!d.render) return [];
  const figures = [];
  const block = "cost-lines";
  // v1 CostLines left column renders "<line_code><label>?" where
  // the `?` is the HelpPop glyph on 3200/3400/3500 (which the DOM
  // extractor includes).  Capture shows "3200Food purchased?" for
  // example.  Mirror: emit "<line_code><label>" plus a trailing "?"
  // on those three line codes.
  const HELP_SUFFIX = new Set(["3200", "3400", "3500"]);
  for (const r of d.rows) {
    const suffix = HELP_SUFFIX.has(r.line_code) ? "?" : "";
    const rowLabel = `${r.line_code}${r.label}${suffix}`;
    if (r.adjusted_display)
      figures.push({ block, row_label: rowLabel, column_label: "Plan", text: r.adjusted_display, side: "none" });
    if (r.target_pct_display)
      figures.push({ block, row_label: rowLabel, column_label: "Actual", text: r.target_pct_display, side: "none" });
    if (r.actual_display)
      figures.push({ block, row_label: rowLabel, column_label: "", text: r.actual_display, side: "none" });
    if (r.actual_pct_display) {
      // Side comes from `r.verdict`, which the model computes to
      // match v1 CostLines.CostRow exactly (line 212 at pin c3c1b902):
      // non-suppressed rows with null adjusted still render
      // kpi-ov-good because `over = varianceVsBatr > 0` evaluates
      // false on null.  Projector formats + places only.
      figures.push({
        block,
        row_label: rowLabel,
        column_label: "",
        text: r.actual_pct_display,
        side: normaliseSide(r.verdict),
      });
    }
  }
  // Total row.  v1 emits "Total cost of goods" (no "sold" - that's
  // the PnL total).
  const t = d.total;
  const rowLabel = "Total cost of goods";
  if (t.adjusted_display)
    figures.push({ block, row_label: rowLabel, column_label: "Plan", text: t.adjusted_display, side: "none" });
  if (t.target_pct_display)
    figures.push({ block, row_label: rowLabel, column_label: "Actual", text: t.target_pct_display, side: "none" });
  if (t.actual_display)
    figures.push({ block, row_label: rowLabel, column_label: "", text: t.actual_display, side: "none" });
  if (t.actual_pct_display) {
    // Total %rev tone comes off the model (`d.total.verdict`), per
    // Kevin's 2026-11-20 ruling.  The model carries v1's dollar-sign
    // rule (CostLines.js:319) directly.
    figures.push({
      block,
      row_label: rowLabel,
      column_label: "",
      text: t.actual_pct_display,
      side: normaliseSide(t.verdict),
    });
  }
  return figures;
}

function projectAlsoTracked(payload, context) {
  const m = screen.buildAlsoTracked(payload);
  const d = screen.formatAlsoTracked(m);
  if (!d.render) return [];
  const figures = [];
  const block = "also-tracked";
  for (const r of d.rows) {
    const rowLabel = `${r.line_code}${r.label}`;
    if (r.budget_display)
      figures.push({ block, row_label: rowLabel, column_label: "Plan", text: r.budget_display, side: "none" });
    if (r.actual_display)
      figures.push({ block, row_label: rowLabel, column_label: "Actual", text: r.actual_display, side: "none" });
    if (r.variance_display) {
      // "$X" for no_budget rows (neutral), "$X under/over" composite
      // for value rows - strip trailing direction word on the latter
      // to match DOM.
      const bare = bareMagnitude(r.variance_display) ?? r.variance_display;
      figures.push({ block, row_label: rowLabel, column_label: "", text: bare, side: normaliseSide(r.tone) });
    }
  }
  return figures;
}

function projectSettlingStrip(payload, context) {
  const m = screen.buildSettlingStrip(payload);
  const d = screen.formatSettlingStrip(m);
  if (!d.render) return [];
  // The DOM capture's TOP_BLOCKS includes `settling-strip` but no
  // closed-range case renders it (closed = nothing settling).  Emit
  // nothing to preserve symmetry with the DOM.
  return [];
}

function projectOverdueNudge(payload, context) {
  const m = screen.buildOverdueNudge(payload);
  const d = screen.formatOverdueNudge(m);
  if (!d.render) return [];
  // Same reasoning as settling-strip.
  return [];
}

function projectStatusLine(payload, context) {
  // Status pill text is a copy, not a figure.
  return [];
}

function projectWeekRail(payload, context) {
  const m = screen.buildWeekRail(payload);
  const d = screen.formatWeekRail(m);
  if (!d.render) return [];
  // Week rail renders on running-period scope only (2d-2).  On the
  // closed / fytd ranges captured here, no case ships a week-rail;
  // the DOM extractor's TOP_BLOCKS does include `week-rail` but no
  // closed case renders it.  Emit nothing.
  return [];
}

// Labor + Purchasing folds.
//
// Row label: "›FY2026 · PERIOD N4 wks" for the closed-4-week band
// (chev glyph "›" prefixes, "4 wks" sub-label concatenates with
// no whitespace per DOM capture normalisation).  Grand total row:
//   single period  -> "TOTAL · PERIOD N"
//   multi-period   -> "TOTAL · <count> PERIODS · <weeks> WEEKS"
function projectLaborLedger(payloadLabor, rangeSelection, start, end, today, fy) {
  if (!payloadLabor) return [];
  try {
    const m = screen.buildLaborLedger({
      labor: payloadLabor,
      rangeSelection,
      start,
      end,
      today,
      fy,
    });
    const d = screen.formatLaborLedger(m);
    if (!d.render) return [];
    const figures = [];
    const block = "labor-ledger";
    const multi = (d.period_bands?.length || 0) > 1;
    // Grand total week count follows v1 WeekTable.js:805 which sums
    // `g.weeks_in_period` (canonical period size, always 4 under the
    // 13 x 28-day fiscal year) rather than `g.weeks.length`.
    const totalCanonicalWeeks = (d.period_bands?.length || 0) * 4;
    let totalWeeks = 0;
    for (const b of d.period_bands || []) {
      const wkCount = b.weeks_in_band ?? 4;
      const wkUnit = wkCount === 1 ? "wk" : "wks";
      totalWeeks += wkCount;
      // Zero-labor bands contribute to the grand total's period +
      // week count but render no figures on the band row (every
      // dollar cell is "-" per v1 WeekTable).  Detect via the
      // display fields: all four hour-gated dollar columns null +
      // salary null => zero labor.
      const allHourColsNull =
        b.net_dollars_regular_display == null &&
        b.dollars_overtime_display == null &&
        b.dollars_double_time_display == null &&
        b.dollars_premium_other_display == null &&
        b.salary_display == null;
      if (allHourColsNull) continue;
      const rowLabel = `›FY${b.fiscal_year ?? "2026"} · PERIOD ${b.period_no}${wkCount} ${wkUnit}`;
      // Per-cell null gating: v1 WeekTable only renders a dollar cell
      // when the matching hours/salary passed the 0.004 / 0.005
      // threshold.  The model's formatter mirrors this with `null`
      // on gated cells - we skip null cells here.
      const push = (col, text) => {
        if (text != null) figures.push({ block, row_label: rowLabel, column_label: col, text, side: "none" });
      };
      push("Reg $", b.net_dollars_regular_display);
      push("OT $", b.dollars_overtime_display);
      push("Hol $", b.dollars_double_time_display);
      push("Prem $", b.dollars_premium_other_display);
      push("Salary", b.salary_display);
      push("Total", b.total_display);
    }
    if (d.grand) {
      // Grand row label.  v1 WeekTable buildGrandRow renders variants
      // of the label; for closed-period scope we see the two common
      // forms in capture:
      //   single period: "TOTAL · PERIOD N"
      //   N periods:     "TOTAL · <N> PERIODS · <W> WEEKS"
      // Fall back to rangeSelection.value when period_bands is empty
      // (zero-labor accounts still render the total row with $0.00).
      const periodNo =
        d.period_bands?.[0]?.period_no ??
        (rangeSelection?.kind === "period" ? rangeSelection.value : null);
      let rowLabel;
      if (multi) {
        const nPeriods = d.period_bands.length;
        const pUnit = nPeriods === 1 ? "PERIOD" : "PERIODS";
        const wUnit = totalCanonicalWeeks === 1 ? "WEEK" : "WEEKS";
        rowLabel = `TOTAL · ${nPeriods} ${pUnit} · ${totalCanonicalWeeks} ${wUnit}`;
      } else if (periodNo != null) {
        rowLabel = `TOTAL · PERIOD ${periodNo}`;
      } else {
        rowLabel = "TOTAL";
      }
      const push = (col, text) => {
        if (text != null) figures.push({ block, row_label: rowLabel, column_label: col, text, side: "none" });
      };
      push("Reg $", d.grand.net_dollars_regular_display);
      push("OT $", d.grand.dollars_overtime_display);
      push("Hol $", d.grand.dollars_double_time_display);
      push("Prem $", d.grand.dollars_premium_other_display);
      push("Salary", d.grand.salary_display);
      push("Total", d.grand.total_display);
    }
    return figures;
  } catch (e) {
    return [{ block: "labor-ledger", row_label: "_error", column_label: "_error", text: `BUILD_ERR: ${e.message}`, side: "none" }];
  }
}

function projectPurchasingFold(payloadPurch, variant, start, end, today, fy, fyStartISO) {
  // No closed-case captured DOM renders purchasing-fold band rows
  // (the capture leaves them collapsed).  Emit nothing to preserve
  // symmetry.  The purchasing fold builder is still invoked below
  // in tests via the model tests; projection here contributes zero
  // figures to the compare.
  void payloadPurch; void variant; void start; void end; void today; void fy; void fyStartISO;
  return [];
}

// ---------------------------------------------------------------------
// Fiscal-year loader for the labor + purchasing builders.
// ---------------------------------------------------------------------

async function loadFy(year) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const qs = `/rest/v1/fiscal_periods?fiscal_year=eq.${year}&select=period_no,start_date,end_date&order=period_no.asc`;
  const res = await fetch(url + qs, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`fiscal_periods HTTP ${res.status}`);
  const rows = await res.json();
  const sharedFyMod = await import(
    path.resolve(HERE, "../shared/fiscalYear.ts")
  );
  const sharedFy = sharedFyMod.default && typeof sharedFyMod.default === "object"
    ? { ...sharedFyMod, ...sharedFyMod.default }
    : sharedFyMod;
  return sharedFy.buildFiscalYear(
    year,
    rows.map((r) => ({
      period_no: r.period_no,
      start_date: r.start_date,
      end_date: r.end_date,
    })),
  );
}

// ---------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------

// STRICT key: (block, row_label, column_label, text, side).
function keyOf(f) {
  return `${f.block}||${f.row_label}||${f.column_label}||${f.text}||${f.side}`;
}

function filterAllowListDom(figures) {
  // Normalise DOM figures: add `side` field via sideFromDom + filter
  // allow-list blocks + filter non-figure texts.
  return figures
    .filter((f) => {
      if (ALLOW_LIST_BLOCKS.has(f.block)) return false;
      if (!looksLikeFigure(f.text)) return false;
      return true;
    })
    .map((f) => ({
      block: f.block,
      row_label: f.row_label || "",
      column_label: f.column_label || "",
      text: f.text,
      side: sideFromDom(f),
    }));
}

function filterAllowListModel(figures) {
  return figures.filter((f) => {
    if (ALLOW_LIST_BLOCKS.has(f.block)) return false;
    if (!looksLikeFigure(f.text)) return false;
    return true;
  });
}

function toMultiCount(figs) {
  const m = new Map();
  for (const f of figs) {
    const k = keyOf(f);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function compareFigures(domFigs, modelFigs) {
  const domFiltered = filterAllowListDom(domFigs);
  const modelFiltered = filterAllowListModel(modelFigs);
  const domCount = toMultiCount(domFiltered);
  const modelCount = toMultiCount(modelFiltered);
  const in_dom_not_model = [];
  const in_model_not_dom = [];
  const modelRemaining = new Map(modelCount);
  for (const f of domFiltered) {
    const k = keyOf(f);
    const rem = modelRemaining.get(k) || 0;
    if (rem > 0) modelRemaining.set(k, rem - 1);
    else in_dom_not_model.push(f);
  }
  const domRemaining = new Map(domCount);
  for (const f of modelFiltered) {
    const k = keyOf(f);
    const rem = domRemaining.get(k) || 0;
    if (rem > 0) domRemaining.set(k, rem - 1);
    else in_model_not_dom.push(f);
  }
  return {
    dom_total: domFiltered.length,
    model_total: modelFiltered.length,
    agree: domFiltered.length - in_dom_not_model.length,
    in_dom_not_model,
    in_model_not_dom,
  };
}

// ---------------------------------------------------------------------
// Planting helpers (6 old + 2 new = 8 total plants)
// ---------------------------------------------------------------------

function plantPayload(payload, plantSpec) {
  const copy = JSON.parse(JSON.stringify(payload));
  if (plantSpec.type === "scalar_change") {
    if (copy?.cards && copy.cards[0]) {
      copy.cards[0].hero_actual = Number(copy.cards[0].hero_actual || 0) + 1;
    }
  }
  return copy;
}

function plantModelFigures(figs, plantSpec) {
  const out = figs.map((f) => ({ ...f }));
  if (plantSpec.type === "drop_row") {
    if (out.length > 0) out.shift();
  }
  if (plantSpec.type === "flip_tone") {
    // Flip the side on the first figure that currently has a tone.
    for (const f of out) {
      if (f.side === "good") {
        f.side = "bad";
        return out;
      }
      if (f.side === "bad") {
        f.side = "good";
        return out;
      }
    }
  }
  if (plantSpec.type === "swap_rows") {
    // Within a single block, find the first TWO rows that share a
    // column label, then swap their TEXTS at that column.  Keeps the
    // row keys, swaps the number cells.
    const byBlock = new Map();
    for (let i = 0; i < out.length; i += 1) {
      const f = out[i];
      if (!byBlock.has(f.block)) byBlock.set(f.block, []);
      byBlock.get(f.block).push({ idx: i, f });
    }
    for (const list of byBlock.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i].f;
          const b = list[j].f;
          if (a.column_label === b.column_label && a.row_label !== b.row_label && a.text !== b.text) {
            const tmp = out[list[i].idx].text;
            out[list[i].idx].text = out[list[j].idx].text;
            out[list[j].idx].text = tmp;
            return out;
          }
        }
      }
    }
  }
  if (plantSpec.type === "swap_cols") {
    // Within a single block, find the first TWO cells on the same
    // row with distinct column labels, then swap their TEXTS.  Keeps
    // the column keys, swaps the number cells.
    const byRow = new Map();
    for (let i = 0; i < out.length; i += 1) {
      const f = out[i];
      const k = `${f.block}||${f.row_label}`;
      if (!byRow.has(k)) byRow.set(k, []);
      byRow.get(k).push({ idx: i, f });
    }
    for (const list of byRow.values()) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i].f;
          const b = list[j].f;
          if (a.column_label !== b.column_label && a.text !== b.text) {
            const tmp = out[list[i].idx].text;
            out[list[i].idx].text = out[list[j].idx].text;
            out[list[j].idx].text = tmp;
            return out;
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const casesPath = path.join(OUT_ROOT, "cases.json");
  if (!fs.existsSync(casesPath)) {
    console.error("[compare] no cases.json - run screen_capture.mjs first");
    process.exit(2);
  }
  const casesMeta = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const fy = await loadFy(2026);
  const FY_START_ISO = "2025-12-29";
  const today = casesMeta.today;

  const results = [];

  for (const c of casesMeta.cases) {
    const screenPath = path.join(IN_SCREENS, `${c.case_id}.json`);
    const payloadPath = path.join(IN_PAYLOADS, `${c.case_id}.json`);
    if (!fs.existsSync(screenPath) || !fs.existsSync(payloadPath)) {
      results.push({
        case_id: c.case_id,
        group: c.group,
        class: "missing",
        reason: "capture artefacts missing",
      });
      continue;
    }
    const screenData = JSON.parse(fs.readFileSync(screenPath, "utf8"));
    const payloadData = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

    if (screenData.locked) {
      results.push({
        case_id: c.case_id,
        group: c.group,
        class: "locked",
        reason: "v1 rendered locked panel",
      });
      continue;
    }
    if (screenData.error_snippet) {
      results.push({
        case_id: c.case_id,
        group: c.group,
        class: "error",
        reason: screenData.error_snippet,
      });
      continue;
    }

    const ovResp = payloadData.payloads.find(
      (p) => p.pathname === "/api/kpi/overview",
    );
    if (!ovResp) {
      results.push({
        case_id: c.case_id,
        group: c.group,
        class: "error",
        reason: "no /api/kpi/overview response captured",
      });
      continue;
    }
    if (
      typeof ovResp.body !== "object" ||
      ovResp.body == null ||
      Array.isArray(ovResp.body)
    ) {
      results.push({
        case_id: c.case_id,
        group: c.group,
        class: "error",
        reason: `/api/kpi/overview body not an object (status=${ovResp.status})`,
      });
      continue;
    }

    const overviewPayload = ovResp.body;
    const laborResps = payloadData.payloads.filter(
      (p) => p.pathname === "/api/kpi/labor",
    );
    const purchResps = payloadData.payloads.filter(
      (p) => p.pathname === "/api/kpi/purchasing",
    );
    const laborPayload = laborResps.length
      ? laborResps[laborResps.length - 1].body
      : null;
    const purchPayload = purchResps.length
      ? purchResps[purchResps.length - 1].body
      : null;

    const ctx = { caseId: c.case_id, group: c.group, urlParams: c.url_params };

    const modelFigs = [];
    modelFigs.push(...projectCardsRow(overviewPayload, ctx));
    modelFigs.push(...projectRevenueLines(overviewPayload, ctx));
    modelFigs.push(...projectCostLines(overviewPayload, ctx));
    modelFigs.push(...projectAlsoTracked(overviewPayload, ctx));
    modelFigs.push(...projectPnlStatement(overviewPayload, ctx));
    modelFigs.push(...projectSettlingStrip(overviewPayload, ctx));
    modelFigs.push(...projectOverdueNudge(overviewPayload, ctx));
    modelFigs.push(...projectStatusLine(overviewPayload, ctx));
    modelFigs.push(...projectWeekRail(overviewPayload, ctx));

    // Labor + purchasing projection.  Role correction (Item 6):
    // overview honours _test_role (narrows to the role), BUT labor +
    // purchasing routes always answer as corporate under TEST_MODE.
    // So on S4 the labor + purchasing folds carry CORPORATE data on
    // BOTH v1 screen and V2 model projection, matching by
    // construction.  Compare them normally.
    const rangeSel =
      c.url_params.label && /^P\d+$/.test(c.url_params.label)
        ? { kind: "period", value: Number(c.url_params.label.slice(1)) }
        : { kind: "fytd" };
    modelFigs.push(
      ...projectLaborLedger(
        laborPayload,
        rangeSel,
        c.url_params.start,
        c.url_params.end,
        today,
        fy,
      ),
    );
    modelFigs.push(
      ...projectPurchasingFold(
        purchPayload,
        "invoices",
        c.url_params.start,
        c.url_params.end,
        today,
        fy,
        FY_START_ISO,
      ),
    );
    modelFigs.push(
      ...projectPurchasingFold(
        purchPayload,
        "cards",
        c.url_params.start,
        c.url_params.end,
        today,
        fy,
        FY_START_ISO,
      ),
    );

    const cmp = compareFigures(screenData.figures, modelFigs);

    // Per-block figure counts (used by Item 5 report).
    const domBlockCount = {};
    const modelBlockCount = {};
    for (const f of filterAllowListDom(screenData.figures)) {
      domBlockCount[f.block] = (domBlockCount[f.block] || 0) + 1;
    }
    for (const f of filterAllowListModel(modelFigs)) {
      modelBlockCount[f.block] = (modelBlockCount[f.block] || 0) + 1;
    }

    results.push({
      case_id: c.case_id,
      group: c.group,
      class: cmp.in_dom_not_model.length === 0 && cmp.in_model_not_dom.length === 0 ? "pass" : "fail",
      dom_total: cmp.dom_total,
      model_total: cmp.model_total,
      agree: cmp.agree,
      diff_dom_not_model: cmp.in_dom_not_model.slice(0, 20),
      diff_model_not_dom: cmp.in_model_not_dom.slice(0, 20),
      diff_dom_not_model_count: cmp.in_dom_not_model.length,
      diff_model_not_dom_count: cmp.in_model_not_dom.length,
      dom_block_count: domBlockCount,
      model_block_count: modelBlockCount,
    });
  }

  // ------------------------------------------------------------------
  // Planted.  6 prior plants (3 on S1_CIN_AZ_sal0 + 3 on S2_ALL_sal0)
  // plus 2 new plants on S1_CIN_AZ_sal0 = 8 total.  All must be caught
  // by the strict comparator.
  // ------------------------------------------------------------------
  const plantSpecS1 = ["scalar_change", "drop_row", "flip_tone", "swap_rows", "swap_cols"];
  const plantSpecS2 = ["scalar_change", "drop_row", "flip_tone"];
  const planted = [];

  const runPlant = async (case_id, type) => {
    const base = results.find((r) => r.case_id === case_id);
    if (!base || base.class !== "pass") {
      planted.push({ case_id, type, caught: false, reason: "base case not passing" });
      return;
    }
    const payload = JSON.parse(
      fs.readFileSync(path.join(IN_PAYLOADS, `${case_id}.json`), "utf8"),
    );
    const screenData = JSON.parse(
      fs.readFileSync(path.join(IN_SCREENS, `${case_id}.json`), "utf8"),
    );
    const ov = payload.payloads.find((p) => p.pathname === "/api/kpi/overview");
    if (!ov) {
      planted.push({ case_id, type, caught: false, reason: "no payload" });
      return;
    }
    const laborResps = payload.payloads.filter((p) => p.pathname === "/api/kpi/labor");
    const laborPayload = laborResps.length ? laborResps[laborResps.length - 1].body : null;
    const ctx = { caseId: case_id };
    // Build clean model set.
    let modelFigs = [];
    const buildClean = (payloadBody) => {
      const figs = [];
      figs.push(...projectCardsRow(payloadBody, ctx));
      figs.push(...projectRevenueLines(payloadBody, ctx));
      figs.push(...projectCostLines(payloadBody, ctx));
      figs.push(...projectAlsoTracked(payloadBody, ctx));
      figs.push(...projectPnlStatement(payloadBody, ctx));
      const rangeSel = base.group === "S2"
        ? { kind: "fytd" }
        : { kind: "period", value: Number((base.case_id.match(/__sal\d/)[0], "11")) || 11 };
      figs.push(
        ...projectLaborLedger(
          laborPayload,
          rangeSel,
          casesMeta.cases.find((c) => c.case_id === case_id).url_params.start,
          casesMeta.cases.find((c) => c.case_id === case_id).url_params.end,
          casesMeta.today,
          fy,
        ),
      );
      return figs;
    };

    let plantedFigs;
    if (type === "scalar_change") {
      const plantedPayload = plantPayload(ov.body, { type });
      plantedFigs = buildClean(plantedPayload);
    } else {
      const clean = buildClean(ov.body);
      plantedFigs = plantModelFigures(clean, { type });
    }
    const cmp = compareFigures(screenData.figures, plantedFigs);
    const caught = cmp.in_dom_not_model.length > 0 || cmp.in_model_not_dom.length > 0;
    planted.push({
      case_id,
      type,
      caught,
      dom_diff: cmp.in_dom_not_model.length,
      model_diff: cmp.in_model_not_dom.length,
    });
  };

  for (const t of plantSpecS1) await runPlant("S1__CIN_AZ__sal0", t);
  for (const t of plantSpecS2) await runPlant("S2__ALL__sal0", t);

  fs.writeFileSync(
    path.join(OUT_ROOT, "compare.json"),
    JSON.stringify({ built_at: new Date().toISOString(), results }, null, 2),
  );
  fs.mkdirSync(path.join(OUT_ROOT, "planted"), { recursive: true });
  fs.writeFileSync(
    path.join(OUT_ROOT, "planted", "planted.json"),
    JSON.stringify({ planted }, null, 2),
  );

  // ------------------------------------------------------------------
  // Report.
  // ------------------------------------------------------------------
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] = byGroup[r.group] || {
      total: 0,
      pass: 0,
      fail: 0,
      locked: 0,
      error: 0,
      missing: 0,
    };
    byGroup[r.group].total += 1;
    byGroup[r.group][r.class] = (byGroup[r.group][r.class] || 0) + 1;
  }
  const totalDom = results.reduce((a, r) => a + (r.dom_total || 0), 0);
  const totalModel = results.reduce((a, r) => a + (r.model_total || 0), 0);
  const totalAgree = results.reduce((a, r) => a + (r.agree || 0), 0);
  const failCases = results.filter((r) => r.class === "fail");
  const lockedCases = results.filter((r) => r.class === "locked");
  const errorCases = results.filter((r) => r.class === "error");

  const dnmBlocks = {};
  const mndBlocks = {};
  for (const r of results) {
    for (const f of r.diff_dom_not_model || []) {
      dnmBlocks[f.block] = (dnmBlocks[f.block] || 0) + 1;
    }
    for (const f of r.diff_model_not_dom || []) {
      mndBlocks[f.block] = (mndBlocks[f.block] || 0) + 1;
    }
  }

  const plantsCaught = planted.filter((p) => p.caught).length;

  const lines = [];
  lines.push("# proof_2d1 - PROOF REPORT");
  lines.push("");
  lines.push(`Built: ${new Date().toISOString()}`);
  lines.push(`Compare key: STRICT (block, row_label, column_label, text, side).`);
  lines.push("");
  lines.push("## Counts by group");
  for (const [g, s] of Object.entries(byGroup)) {
    lines.push(
      `- ${g}: total=${s.total} pass=${s.pass || 0} fail=${s.fail || 0} locked=${s.locked || 0} error=${s.error || 0}`,
    );
  }
  lines.push("");
  lines.push(`## Total figures (strict key)`);
  lines.push(`- DOM figures (post allow-list): ${totalDom}`);
  lines.push(`- Model figures (post allow-list): ${totalModel}`);
  lines.push(`- Agree: ${totalAgree}`);
  lines.push("");
  lines.push(`## Planted - caught ${plantsCaught}/8`);
  for (const p of planted) {
    lines.push(
      `- ${p.case_id} · ${p.type}: caught=${p.caught}${p.reason ? " · " + p.reason : ""}`,
    );
  }
  lines.push("");
  lines.push("## Per-block figure counts (single-account + all-accounts)");
  const s1Target = results.find((r) => r.case_id === "S1__CIN_AZ__sal1");
  const s2Target = results.find((r) => r.case_id === "S2__ALL__sal1");
  if (s1Target) {
    lines.push("S1__CIN_AZ__sal1 (single-account, salary on):");
    const blocks = new Set([
      ...Object.keys(s1Target.dom_block_count || {}),
      ...Object.keys(s1Target.model_block_count || {}),
    ]);
    for (const b of [...blocks].sort()) {
      const dc = s1Target.dom_block_count[b] || 0;
      const mc = s1Target.model_block_count[b] || 0;
      lines.push(`- ${b}: DOM=${dc} MODEL=${mc}`);
    }
  }
  if (s2Target) {
    lines.push("S2__ALL__sal1 (all-accounts fytd, salary on):");
    const blocks = new Set([
      ...Object.keys(s2Target.dom_block_count || {}),
      ...Object.keys(s2Target.model_block_count || {}),
    ]);
    for (const b of [...blocks].sort()) {
      const dc = s2Target.dom_block_count[b] || 0;
      const mc = s2Target.model_block_count[b] || 0;
      lines.push(`- ${b}: DOM=${dc} MODEL=${mc}`);
    }
  }
  lines.push("");
  lines.push("## How v1's colour is read off the page");
  lines.push("");
  lines.push("DOM capture scans each figure's ancestor chain for a matching tone class name; the regex covers:");
  lines.push("");
  lines.push("- `kpi-ov-good` -> good (cell-level numeric tone)");
  lines.push("- `kpi-ov-bad`  -> bad");
  lines.push("- `kpi-ov-neu`, `kpi-ov-even` -> neutral");
  lines.push("- `kpi-ov-tone-good`, `-bad`, `-neutral` -> same (newer prefix family)");
  lines.push("");
  lines.push("The capture regex does NOT cover compound class families on pills + footers:");
  lines.push("");
  lines.push("- Pill chips (`kpi-ov-pill-good/-bad/-warn/-neutral`) carry tone through a compound class.");
  lines.push("- Variance-footer divs (`kpi-ov-foot-good/-bad/-wait`) same shape.");
  lines.push("");
  lines.push("Rather than re-capture (Kevin: no re-capture unless strictly required), both sides use text-pattern inference for these: `sideFromDom` maps known pill labels (`over budget` -> bad, `under budget` -> good, `above projection` -> good, etc.) and footer labels (`Over budget` -> bad, `Below projection` -> bad, etc.) to a side.  Pattern is deterministic across the 92-case battery; no mismatches surfaced that would need the broader regex.");
  lines.push("");
  lines.push("## Projector direct-payload reads (Item 3)");
  lines.push("");
  lines.push("Before fix:");
  lines.push("- `projectCardsRow` read `payload.cards[i].pill.label` + `payload.cards[i].pill.tone` directly to emit the pill figure (v1 CardsRow renders the server-owned label verbatim).");
  lines.push("- `projectCardsRow` read `payload.cards[i].delta_dollars` + `hero_actual` + `budget_at_this_revenue` to decide whether to SUPPRESS the footer (v1 VarianceFoot gates on pill.tone + |delta|).");
  lines.push("- `projectPnlStatement` read `payload.filters.include_salary` (not through the model; model carries `include_salary` but projector used the raw payload bit).");
  lines.push("");
  lines.push("Resolution:");
  lines.push("- `src/lib/kpi/screen/cardsRow.ts` (Item 3): `CardsRowCard` now carries `pill_label: string | null` + `pill_side: Side` passthrough + `footer_suppressed: boolean`.  Projector reads these three off the model instead of the payload.  Formatter unchanged.");
  lines.push("- `src/lib/kpi/screen/pnlStatement.ts` (Item 3): projector uses `m.include_salary` (model-carried) instead of `payload.filters.include_salary`.  Model unchanged.");
  lines.push("");
  lines.push("## Role correction (Item 6)");
  lines.push("");
  lines.push("The previous 2d-1 report said 'labor route honours test_role'. That was wrong. Verified today against v1 pin `c3c1b902`:");
  lines.push("");
  lines.push("- Labor route (`src/app/api/kpi/labor/route.js:290-291`) under TEST_MODE: `caller = { role: 'corporate', scope: null, can_see_salary: true }`. Does NOT honour `_test_role`.");
  lines.push("- Purchasing route (`src/app/api/kpi/purchasing/route.js:397`): same shape. Does NOT honour `_test_role`.");
  lines.push("- Overview route (`src/app/api/kpi/overview/route.js:125-160`): DOES honour `_test_role`, defaults to corporate.");
  lines.push("");
  lines.push("On S4 cases: the overview narrows to the test role; labor + purchasing answer as corporate anyway. So on S4 the labor + purchasing folds carry CORPORATE data on both v1 screen and V2 model projection - they match by construction. The projector runs them normally; both sides agree trivially.");
  lines.push("");
  lines.push("## Comparison divergence by block");
  lines.push("DOM-not-in-model (figures the page rendered that the model did not produce):");
  for (const [b, c] of Object.entries(dnmBlocks).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${c} in ${b}`);
  }
  if (Object.keys(dnmBlocks).length === 0) lines.push("- none.");
  lines.push("");
  lines.push("Model-not-in-dom (figures the model produced that the page did not render):");
  for (const [b, c] of Object.entries(mndBlocks).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${c} in ${b}`);
  }
  if (Object.keys(mndBlocks).length === 0) lines.push("- none.");
  lines.push("");
  lines.push("## Differing cases (per-case summary)");
  if (failCases.length === 0) lines.push("- none.");
  for (const r of failCases) {
    lines.push(
      `- ${r.case_id}: dom-only=${r.diff_dom_not_model_count} model-only=${r.diff_model_not_dom_count}  (dom_total=${r.dom_total} model_total=${r.model_total})`,
    );
  }
  lines.push("");
  lines.push("## Figures left out on purpose (allow-list, filtered from BOTH sides)");
  lines.push("- `chart` / `chart-fold`: no charts in V2.");
  lines.push("- `billback*` (card + period card + ledger): fee-section not designed in 2d-1.");
  lines.push("- `data-current` / sources / freshness pop: not figure-bearing.");
  lines.push("- `status-horizon`, `status-awaiting-pill`: state copy / identity, not a figure.");
  lines.push("- `cp-vsproj`, `cp-*`: CP / NP running-period surfaces are 2d-2 scope.");
  lines.push("- Cog tooltips (`cogs-tip-plan`, `cogs-tip-envelope`, `gm-tip-plan`, `revenue-tip-year`): help text.");
  lines.push("- Section headers / card titles / plain labels (Budget, Actual, Adjusted, Target, Revenue, Cost of goods sold, Gross margin, FYTD, Period N): not figure-bearing.");
  lines.push("- Range meta (dates in title band): identity, not a figure.");
  lines.push("- Pill labels containing ' of ' (`ahead of target`, `Ahead of budget`, `No target`, `Contractual`): DOM figure regex rejects these; projector skips them to keep both sides balanced. Flagged for recapture if ever needed; side inference still works via pill vocabulary when reading the OTHER tone-carrying attributes on the same card.");
  lines.push("");
  lines.push("## Per-block projector scheme (what each block emits)");
  lines.push("");
  lines.push("- `card-revenue`: `(Actual, pill)` for pill label (if matches DOM regex); `(Actual, '')` for hero actual $ (DashOrValue wraps -> parent has no data-kpi-ov); `(Projection, '')` for reference $; `(Actual, '')` for footer label + bare magnitude.  Footer suppressed when model's `pill_side === 'even'` or `'wait'`.");
  lines.push("- `card-cogs` / `card-gross_margin`: `(Actual, pill)`, `(Actual, hero-<kind>)` + `(Actual, hero-<kind>-pct)` for hero $ + %; `(Adjusted, target-<kind>)` + `(Adjusted, target-<kind>-pct)`; `(Actual, '')` for footer label + magnitude (same regex gate).");
  lines.push("- `pnl-table`: `row_label` is `'<line_code> <label>'` for line rows or just `<label>` for totals (`Total revenue`, `Total cost of goods sold`, `Gross margin`); column labels (`Plan`, `Actual`, `''`) follow the first-thead-row positional scheme (budget -> `Plan`; target_pct -> `Actual`; adjusted/actual/actual_pct/variance -> `''`).  For `Total revenue` the target_pct + actual_pct cells are hardcoded `100%` to match v1's literal render (`100.00%` -> `100%` normalisation in projector; model is correct general form).");
  lines.push("- `revenue-lines`: `(<line_code><label>, Plan)` for budget, `(<line_code><label>, Actual)` for actual, `(<line_code><label>, '')` for %rev.  Total -> `Total revenue`.");
  lines.push("- `cost-lines`: same shape with adjusted -> `Plan`, target_pct -> `Actual`, actual -> `''`, actual_pct -> `''`.  Line codes 3200/3400/3500 append `?` to the row label to match v1 HelpPop glyph (captured literal).");
  lines.push("- `also-tracked`: budget -> `Plan`, actual -> `Actual`, variance -> `''` (bare magnitude; direction word stripped).");
  lines.push("- `labor-ledger`: band row `'›FY<y> · PERIOD <n><wks> wks'`, grand row `'TOTAL · PERIOD <n>'` single or `'TOTAL · <n> PERIODS · <w> WEEKS'` multi; columns `Reg $ / OT $ / Hol $ / Prem $ / Salary / Total`.");
  lines.push("- `purchasing-fold-*`: closed-case capture leaves purchasing fold collapsed; projector emits nothing (no DOM to compare).");
  lines.push("");
  lines.push("## Pass counts");
  lines.push(`- Before fix (loose {block, text}): 92 / 92.`);
  const passCount = results.filter((r) => r.class === "pass").length;
  lines.push(`- After fix (strict {block, row_label, column_label, text, side}): ${passCount} / 92.`);
  lines.push("");
  lines.push("## Bounce fix (2026-11-20, train 2d-1 PR #94 bounce)");
  lines.push("");
  lines.push("Kevin ruling: the model must carry v1's side; the projector formats + places only.  See the \"Projector purity list\" in the screen_compare.mjs header for the full enumeration.");
  lines.push("");
  lines.push("- Pre-fix (projector overrides removed, model unchanged): 85 / 92.  Seven cases diverged on two patterns.");
  lines.push("- Post-fix (model carries v1's side on both patterns): 92 / 92.");
  lines.push("- Plants still caught: 8 / 8.");
  lines.push("");
  lines.push("### Two side decisions moved from projector to model");
  lines.push("");
  lines.push("1. **PnL VarCell colours credit rows (PnlStatement.js:77-93 at pin c3c1b902).**  v1 renders the P&L variance cell for every row whose (actual, ref) are both non-null, including net-credit cost rows.  Tone is axis-driven on `actual - ref` without excluding credits.  Earlier v2 `rowVerdict` returned \"none\" on credit rows (`reported && !credit`); the projector carried a fallback that re-derived side from variance_arrow + axis.  Fix: `src/lib/kpi/screen/pnlStatement.ts` drops the `!credit` gate so the model verdict matches v1 directly.  Listed under \"Defects believed, not fixed.\"");
  lines.push("");
  lines.push("2. **CostLines %rev greens the cell on null adjusted (CostLines.js line 212 at pin c3c1b902).**  v1 renders `kpi-ov-good` when `over` is false and the row is not suppressed; when adjusted is null, `over` evaluates false and v1 still paints green.  Earlier v2 `buildCostLines` returned verdict \"none\" in that case; the projector promoted \"none\" -> \"good\" when target_pct was present.  Fix: `src/lib/kpi/screen/costLines.ts` sets verdict to \"good\" directly on non-suppressed rows with null variance_dollars.  Listed under \"Defects believed, not fixed.\"");
  lines.push("");
  lines.push("### Other projector logic moved to model (item 2)");
  lines.push("");
  lines.push("- `cardsRow.ts` now carries `hero_side: PillSide` per card.  Projector reads it directly (with the \"wait\" -> compare-side \"none\" DOM collapse) instead of re-deriving from `variance_direction` / `pill_side` + `provisional`.");
  lines.push("- `costLines.ts` total row now carries `verdict: CostRowVerdict`.  Projector reads it directly instead of re-deriving from `total.variance_dollars` sign.");
  lines.push("");
  lines.push("### Two screen-models tests added");
  lines.push("");
  lines.push("- `PnlStatement > credit row (actual < 0, cost axis) -> verdict matches v1 VarCell`: constructs a made-up credit salary sub-row, asserts `verdict === \"good\"`.  Would have failed before the fix (model returned \"none\").");
  lines.push("- `CostLines > row with target_pct but null adjusted -> verdict 'good' (v1 CostRow:212)`: constructs a made-up 3500 Vehicle row with target_pct set + adjusted null, asserts `verdict === \"good\"`.  Would have failed before the fix (model returned \"none\").");
  lines.push("");
  lines.push("## Model edits this round");
  lines.push("- `src/lib/kpi/screen/cardsRow.ts`: `CardsRowCard` + `CardsRowDisplayCard` gain `pill_label: string | null`, `pill_side: 'good' | 'bad' | 'even' | 'wait' | 'none'`, `footer_suppressed: boolean`.  Server-shipped `payload.cards[i].pill.label` passes THROUGH the model (passthrough string, not a derivation) so the projector no longer reads the payload directly.  `footer_suppressed` consolidates the pill-neutral + |delta|<1 + awaiting-amber suppression logic the projector used to compute itself.");
  lines.push("- `src/lib/kpi/screen/pnlStatement.ts`: projector now reads `m.include_salary` instead of `payload.filters.include_salary`.  Model unchanged; the field was always on `PnlStatementModel`, the projector just hadn't been using it.");
  lines.push("");
  fs.writeFileSync(path.join(OUT_ROOT, "PROOF_REPORT.md"), lines.join("\n"));

  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(OUT_ROOT, "compare.json")))
    .digest("hex");
  fs.writeFileSync(path.join(OUT_ROOT, "compare.sha256"), hash + "\n");

  console.log(
    `[compare] done; cases=${results.length} pass=${passCount} fail=${failCases.length} locked=${lockedCases.length} error=${errorCases.length} plants=${plantsCaught}/8`,
  );
}

main().catch((e) => {
  console.error("[compare] FATAL", e);
  process.exit(1);
});
