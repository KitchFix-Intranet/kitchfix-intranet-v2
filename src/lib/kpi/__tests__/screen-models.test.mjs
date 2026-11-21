// Hand-built tests for the train-2d-1 screen-model builders.
//
// Each case constructs a made-up payload and asserts the model
// returned by the builder; the formatter is spot-checked where its
// copy is a load-bearing string. No real account name, vendor, or
// dollar figure is used. Values are small integers where possible so
// a reader can verify the arithmetic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildStatusLine, formatStatusLine, buildAwaiting } from "../screen/statusLine.js";
import { buildSettlingStrip, formatSettlingStrip } from "../screen/settlingStrip.js";
import { buildOverdueNudge, formatOverdueNudge } from "../screen/overdueNudge.js";
import { buildCardsRow, formatCardsRow } from "../screen/cardsRow.js";
import { buildRevenueLines, formatRevenueLines } from "../screen/revenueLines.js";
import { buildCostLines, formatCostLines } from "../screen/costLines.js";
import { buildAlsoTracked, formatAlsoTracked } from "../screen/alsoTracked.js";
import { buildPnlStatement, formatPnlStatement } from "../screen/pnlStatement.js";
import { buildWeekRail, formatWeekRail } from "../screen/weekRail.js";
import { buildLaborLedger, formatLaborLedger } from "../screen/laborLedger.js";
import { buildPurchasingFold, formatPurchasingFold } from "../screen/purchasingFold.js";
import { buildFiscalYear } from "../shared/fiscalYear.js";

const FY2026 = buildFiscalYear(2026, [
  { period_no: 1,  start_date: "2025-12-29", end_date: "2026-01-25" },
  { period_no: 2,  start_date: "2026-01-26", end_date: "2026-02-22" },
  { period_no: 3,  start_date: "2026-02-23", end_date: "2026-03-22" },
  { period_no: 4,  start_date: "2026-03-23", end_date: "2026-04-19" },
  { period_no: 5,  start_date: "2026-04-20", end_date: "2026-05-17" },
  { period_no: 6,  start_date: "2026-05-18", end_date: "2026-06-14" },
  { period_no: 7,  start_date: "2026-06-15", end_date: "2026-07-12" },
  { period_no: 8,  start_date: "2026-07-13", end_date: "2026-08-09" },
  { period_no: 9,  start_date: "2026-08-10", end_date: "2026-09-06" },
  { period_no: 10, start_date: "2026-09-07", end_date: "2026-10-04" },
  { period_no: 11, start_date: "2026-10-05", end_date: "2026-11-01" },
  { period_no: 12, start_date: "2026-11-02", end_date: "2026-11-29" },
  { period_no: 13, start_date: "2026-11-30", end_date: "2026-12-27" },
]);

// ─── StatusLine ───────────────────────────────────────────────────

describe("StatusLine", () => {
  it("renders state + horizon on closed single", () => {
    const payload = {
      status_line: { state: "verified", state_copy: "Closed · verified", tone: "good" },
      range_labels: { horizon: "P8 · closed and verified" },
    };
    const m = buildStatusLine(payload, null);
    assert.equal(m.state, "verified");
    assert.equal(m.tone, "good");
    assert.equal(m.state_copy, "Closed · verified");
    assert.equal(m.leading_dot, false);
    assert.equal(m.horizon, "P8 · closed and verified");
    assert.equal(m.awaiting, null);
  });

  it("wait tone -> leading_dot true", () => {
    const m = buildStatusLine(
      { status_line: { state: "awaiting", state_copy: "Awaiting verification", tone: "wait" } },
      null,
    );
    assert.equal(m.leading_dot, true);
  });

  it("buildAwaiting on fytd with excluded period", () => {
    // v1 math: settle = close + 8 days UTC.
    const a = buildAwaiting("fytd", 9, "2026-09-06");
    assert.deepEqual(a, {
      period_no: 9,
      close_iso: "2026-09-06",
      settle_iso: "2026-09-14",
    });
  });

  it("buildAwaiting returns null off fytd", () => {
    assert.equal(buildAwaiting("this_period", 9, "2026-09-06"), null);
  });

  it("formatStatusLine composes awaiting copy without leading zero", () => {
    const m = buildStatusLine(
      { status_line: { state: "verified", state_copy: "Closed · verified", tone: "good" } },
      { period_no: 9, close_iso: "2026-09-06", settle_iso: "2026-09-04" },
    );
    const d = formatStatusLine(m);
    assert.equal(d.awaiting_copy, "P9 awaiting verification · closes 9/4");
  });
});

// ─── SettlingStrip ────────────────────────────────────────────────

describe("SettlingStrip", () => {
  it("renders purchases + labour when labour hours > threshold", () => {
    const m = buildSettlingStrip({
      settling: { period_no: 9, period_end: "2026-09-06", labour: { hours: 12.5, people: 3 } },
    });
    assert.equal(m.render, true);
    assert.equal(m.period_no, 9);
    assert.deepEqual(m.purchases, { period_no: 9 });
    assert.deepEqual(m.labour, { hours: 12.5, people: 3 });
    const d = formatSettlingStrip(m);
    assert.equal(d.purchases_line, "Invoices for P9 finalizing, Invoices and Credit Card charges land on the nightly sync.");
    assert.equal(d.labour_line, "12.50 hrs awaiting approval across 3 people · lands as they are approved");
  });

  it("drops labour below threshold (< 0.04 hrs OR 0 people)", () => {
    const m = buildSettlingStrip({
      settling: { period_no: 9, labour: { hours: 0.02, people: 2 } },
    });
    assert.equal(m.labour, null);
  });

  it("render false when settling absent", () => {
    const m = buildSettlingStrip({});
    assert.equal(m.render, false);
  });

  it("single person formats 'person' not 'people'", () => {
    const m = buildSettlingStrip({
      settling: { period_no: 3, labour: { hours: 2, people: 1 } },
    });
    const d = formatSettlingStrip(m);
    assert.ok(d.labour_line.includes("1 person"));
  });
});

// ─── OverdueNudge ─────────────────────────────────────────────────

describe("OverdueNudge", () => {
  it("empty -> no render", () => {
    assert.equal(buildOverdueNudge({}).render, false);
    assert.equal(buildOverdueNudge({ overdue_periods: [] }).render, false);
  });
  it("single entry line (plural days)", () => {
    const m = buildOverdueNudge({
      overdue_periods: [{ period_no: 7, period_end_iso: "2026-07-12", days_since_close: 14 }],
    });
    assert.equal(m.render, true);
    const d = formatOverdueNudge(m);
    assert.equal(d.lines[0], "P7 closed 14 days ago · no finance P&L loaded");
  });
  it("single day pluralises 'day'", () => {
    const d = formatOverdueNudge(
      buildOverdueNudge({
        overdue_periods: [{ period_no: 4, period_end_iso: "2026-04-19", days_since_close: 1 }],
      }),
    );
    assert.ok(d.lines[0].includes("1 day"));
  });
});

// ─── CardsRow ─────────────────────────────────────────────────────

describe("CardsRow", () => {
  const PAYLOAD = {
    range: { kind: "single_closed", period_no: 8 },
    period_state: "verified",
    has_target: true,
    revenue_source_state: "verified",
    revenue_model: "per_meal",
    sc_counts_without_dollars: null,
    cards: [
      { key: "revenue", hero_actual: 100000, budget_full_period: 90000, budget_to_date: 90000, delta_dollars: 10000, pill: { tone: "good", label: "Above" } },
      { key: "cogs", hero_actual: 52000, budget_at_this_revenue: 50000, budget_full_period: 45000, pct_of_revenue: 52, adjusted_pct_of_revenue: 50, target_pct: 50, pill: { tone: "bad", label: "Over" } },
      { key: "gross_margin", hero_actual: 48000, budget_at_this_revenue: 50000, budget_full_period: 45000, pct_of_revenue: 48, adjusted_pct_of_revenue: 50, target_pct: 50, pill: { tone: "bad", label: "Behind" } },
    ],
  };

  it("shapes closed-range cards", () => {
    const m = buildCardsRow(PAYLOAD);
    assert.equal(m.render, true);
    assert.equal(m.revenue_absent, false);
    assert.equal(m.revenue.actual, 100000);
    assert.equal(m.revenue.budget, 90000);  // closed uses budget_full_period
    assert.equal(m.revenue.gap_dollars, 10000);
    assert.equal(m.revenue.verdict, "good");
    assert.equal(m.cogs.actual, 52000);
    assert.equal(m.cogs.adjusted, 50000);
    assert.equal(m.cogs.gap_dollars, 2000);
    assert.equal(m.cogs.gap_points, 2);
    assert.equal(m.cogs.verdict, "bad");
    assert.equal(m.gross_margin.actual, 48000);
    assert.equal(m.gross_margin.gap_dollars, -2000);
    assert.equal(m.gross_margin.verdict, "bad");
  });

  it("fytd closed uses budget_to_date for revenue reference", () => {
    const p = { ...PAYLOAD, range: { kind: "fytd" } };
    const m = buildCardsRow(p);
    assert.equal(m.revenue.budget, 90000);  // budget_to_date
  });

  it("sc_counts_without_dollars -> revenue_absent", () => {
    const m = buildCardsRow({ ...PAYLOAD, sc_counts_without_dollars: { row_count: 3 } });
    assert.equal(m.revenue_absent, true);
  });

  it("awaiting -> provisional on cost + margin", () => {
    const m = buildCardsRow({ ...PAYLOAD, awaiting: true });
    assert.equal(m.cogs.provisional, true);
    assert.equal(m.gross_margin.provisional, true);
    assert.equal(m.revenue.provisional, false);
  });

  it("formatter: Over/Under budget copy + arrows", () => {
    const m = buildCardsRow(PAYLOAD);
    const d = formatCardsRow(m);
    assert.equal(d.cogs.variance_label, "Over budget");
    assert.equal(d.cogs.variance_arrow, "▲");
    assert.equal(d.gross_margin.variance_label, "Behind budget");
    assert.equal(d.gross_margin.variance_arrow, "▼");
    assert.equal(d.revenue.variance_label, "Above projection");
  });

  it("budget zero -> card still renders with zero", () => {
    const p = {
      ...PAYLOAD,
      cards: [
        { key: "revenue", hero_actual: 0, budget_full_period: 0, delta_dollars: 0, pill: { tone: "neutral", label: "—" } },
        { key: "cogs", hero_actual: 0, budget_at_this_revenue: 0, budget_full_period: 0, pct_of_revenue: 0, adjusted_pct_of_revenue: 0, target_pct: 0, pill: { tone: "neutral" } },
        { key: "gross_margin", hero_actual: 0, budget_at_this_revenue: 0, pct_of_revenue: 0, adjusted_pct_of_revenue: 0, target_pct: 0, pill: { tone: "neutral" } },
      ],
    };
    const m = buildCardsRow(p);
    assert.equal(m.revenue.actual, 0);
    assert.equal(m.cogs.gap_dollars, 0);
    assert.equal(m.cogs.verdict, "even");
  });

  it("missing card returns null slots (verdict none)", () => {
    const m = buildCardsRow({ cards: [] });
    assert.equal(m.render, true);   // cards[] present even if empty
    assert.equal(m.revenue.actual, null);
    assert.equal(m.revenue.verdict, "none");
  });
});

// ─── RevenueLines ─────────────────────────────────────────────────

describe("RevenueLines", () => {
  const PAYLOAD = {
    period_state: "verified",
    revenue_source_state: "verified",
    range: { kind: "single_closed", period_no: 8 },
    range_labels: { budget_header: "P8 BUDGET", actuals_header: "P8 ACTUALS" },
    cards: [{ key: "revenue", hero_actual: 100000 }],
    statement_rows: [
      { section: "revenue", line_code: "2300", label: "Service charges", budget_to_date: 80000, actual: 80000, reported: true, flags: [] },
      { section: "revenue", line_code: "2400.1", label: "Meal service", budget_to_date: 20000, actual: 20000, reported: true, flags: [] },
      { section: "revenue", line_code: "2400.2", label: "Meal service away", budget_to_date: 0, actual: 0, reported: true, flags: ["inactive"] },   // filtered out
      { section: "cogs", line_code: "3100", label: "Labor", actual: 50000 },  // irrelevant section
    ],
  };

  it("filters inactive, totals, picks pill", () => {
    const m = buildRevenueLines(PAYLOAD);
    assert.equal(m.render, true);
    assert.equal(m.rows.length, 2);
    assert.equal(m.total.budget, 100000);
    assert.equal(m.total.actual, 100000);
    assert.equal(m.pill.text, "Verified");
    assert.equal(m.pill.tone, "good");
  });

  it("per-row pct of total revenue", () => {
    const m = buildRevenueLines(PAYLOAD);
    const sc = m.rows.find((r) => r.line_code === "2300");
    assert.equal(sc.pct, 80);
  });

  it("not-reported line -> actual null, pct null", () => {
    const m = buildRevenueLines({
      ...PAYLOAD,
      statement_rows: [
        { section: "revenue", line_code: "2300", budget_to_date: 100, actual: null, reported: false, flags: [] },
      ],
    });
    assert.equal(m.rows[0].actual, null);
    assert.equal(m.rows[0].pct, null);
  });

  it("composition pill on multi-period", () => {
    const m = buildRevenueLines({
      ...PAYLOAD,
      range_composition: { periods_total: 8, verified: { count: 8 }, live: { count: 0 }, planned: { count: 0 } },
    });
    assert.equal(m.pill.text, "8 verified");
    assert.equal(m.pill.tone, "neutral");
  });

  it("formatter emits displays + 100% total pct", () => {
    const d = formatRevenueLines(buildRevenueLines(PAYLOAD));
    assert.equal(d.total.pct_display, "100%");
  });
});

// ─── CostLines ────────────────────────────────────────────────────

describe("CostLines", () => {
  const PAYLOAD = {
    period_state: "verified",
    has_target: true,
    range: { kind: "single_closed", period_no: 8 },
    cards: [{ key: "cogs", pct_of_revenue: 52, adjusted_pct_of_revenue: 50 }],
    statement_rows: [
      // scored rows
      { section: "cogs", line_code: "3100", label: "Labor", budget_at_this_revenue: 30000, actual: 32000, actual_pct: 32, target_pct: 30, flags: [] },
      { section: "cogs", line_code: "3200", label: "Food", budget_at_this_revenue: 15000, actual: 14000, actual_pct: 14, target_pct: 15, flags: [] },
      // billed-back (suppressed) + inactive + credit
      { section: "cogs", line_code: "3400", label: "Pack", budget_at_this_revenue: null, actual: 200, actual_pct: null, target_pct: null, flags: ["billed_back"] },
      { section: "cogs", line_code: "3500", label: "Vehicle", budget_at_this_revenue: null, actual: null, flags: ["inactive"] },
      { section: "cogs", line_code: "3200.1", label: "Resale credit", budget_at_this_revenue: 500, actual: -300, flags: [], parent_line_code: "3200" }, // sub, excluded by parent filter
    ],
  };

  it("scored sum + total + over_count", () => {
    const m = buildCostLines(PAYLOAD);
    assert.equal(m.render, true);
    assert.equal(m.rows.length, 4);   // 3100, 3200, 3400, 3500 - sub excluded
    assert.equal(m.total.adjusted, 45000);   // 30k + 15k; billed-back + inactive excluded
    assert.equal(m.total.actual_scored, 46000); // 32k + 14k
    assert.equal(m.total.actual_all, 32000 + 14000 + 200);  // includes billed-back actual
    assert.equal(m.pill.state, "any_over");
    assert.equal(m.pill.over_count, 1);         // 3100 over, 3200 under
  });

  it("credit row -> suppresses verdict + pct", () => {
    const m = buildCostLines({
      ...PAYLOAD,
      statement_rows: [
        { section: "cogs", line_code: "3200", label: "Food", budget_at_this_revenue: 100, actual: -50, flags: [] },
      ],
    });
    const r = m.rows[0];
    assert.equal(r.credit, true);
    assert.equal(r.verdict, "none");
  });

  it("all under -> pill good", () => {
    const m = buildCostLines({
      ...PAYLOAD,
      statement_rows: [
        { section: "cogs", line_code: "3100", budget_at_this_revenue: 100, actual: 90, actual_pct: 10, target_pct: 10, flags: [] },
      ],
    });
    assert.equal(m.pill.state, "all_under");
  });

  it("nothing spent yet (no scored actuals > 0.5)", () => {
    const m = buildCostLines({
      ...PAYLOAD,
      statement_rows: [
        { section: "cogs", line_code: "3100", budget_at_this_revenue: 100, actual: 0, flags: [] },
      ],
    });
    assert.equal(m.pill.state, "none_spent");
  });

  it("formatter: Adjusted on billed_back reads 'billed back'", () => {
    const d = formatCostLines(buildCostLines(PAYLOAD));
    const bb = d.rows.find((r) => r.line_code === "3400");
    assert.equal(bb.adjusted_display, "billed back");
  });

  it("not active -> row displays 'not active'", () => {
    const m = buildCostLines({
      ...PAYLOAD,
      statement_rows: [
        { section: "cogs", line_code: "3500", flags: ["inactive"] },
      ],
    });
    const d = formatCostLines(m);
    assert.equal(d.rows[0].adjusted_display, "not active");
  });
});

// ─── AlsoTracked ──────────────────────────────────────────────────

describe("AlsoTracked", () => {
  it("empty + no-budget + value rows", () => {
    const m = buildAlsoTracked({
      also_tracked: [
        { line_code: "5002.1", label: "R&M", actual: 0, budget: 0 },             // empty
        { line_code: "5002.5", label: "Equipment", actual: 100, budget: 0 },     // no-budget
        { line_code: "5017.3", label: "Perks", actual: 150, budget: 200, variance: -50 },  // under
        { line_code: "5100", label: "Other", actual: 300, budget: 200, variance: 100 },    // over
      ],
    });
    assert.equal(m.render, true);
    assert.equal(m.rows[0].state, "empty");
    assert.equal(m.rows[1].state, "no_budget");
    assert.equal(m.rows[2].state, "value");
    assert.equal(m.rows[2].tone, "good");
    assert.equal(m.rows[3].tone, "bad");
    const d = formatAlsoTracked(m);
    assert.equal(d.rows[0].empty_phrase, "no spend");
    assert.equal(d.rows[2].variance_display, "$50 under");
    assert.equal(d.rows[3].variance_display, "$100 over");
  });

  it("on-budget tone + display", () => {
    const m = buildAlsoTracked({
      also_tracked: [{ line_code: "5002.1", label: "R&M", actual: 100, budget: 100, variance: 0 }],
    });
    assert.equal(m.rows[0].tone, "even");
    const d = formatAlsoTracked(m);
    assert.equal(d.rows[0].variance_display, "on budget");
  });
});

// ─── PnlStatement ─────────────────────────────────────────────────

describe("PnlStatement", () => {
  const PAYLOAD = {
    period_state: "verified",
    range: { kind: "single_closed", period_no: 8 },
    filters: { include_salary: true, account: "TEST" },
    cards: [
      { key: "revenue", hero_actual: 100000 },
      { key: "cogs", hero_actual: 52000 },
      { key: "gross_margin", hero_actual: 48000 },
    ],
    statement_totals: {
      revenue: { budget_to_date: 90000, actual: 100000 },
      cogs: { budget_to_date: 45000, budget_at_this_revenue: 50000, actual: 52000, actual_pct: 52, target_pct: 50 },
      gross_margin: { budget_to_date: 45000, margin_at_this_revenue: 50000, actual: 48000, actual_pct: 48, target_pct: 50 },
    },
    statement_rows: [
      { section: "revenue", line_code: "2400.1", label: "Meals", budget_to_date: 100000, actual: 100000, reported: true, flags: [] },
      { section: "cogs", line_code: "3100", label: "Labor", budget_to_date: 32000, target_pct: 32, budget_at_this_revenue: 35000, actual: 36000, actual_pct: 36, reported: true, flags: [] },
      { section: "cogs", line_code: "3100.1", label: "Hourly", parent_line_code: "3100", budget_to_date: 10000, target_pct: 10, budget_at_this_revenue: 11000, actual: 12000, reported: true, flags: [] },
      { section: "cogs", line_code: "3100.2", label: "Salary", parent_line_code: "3100", budget_to_date: 22000, target_pct: null, budget_at_this_revenue: null, actual: 24000, reported: true, flags: ["not_applicable_target_pct"] },
      { section: "cogs", line_code: "3200", label: "Food", budget_to_date: 15000, target_pct: 15, budget_at_this_revenue: 16000, actual: 14000, actual_pct: 14, reported: true, flags: [] },
    ],
    also_tracked: [{ line_code: "5017.3", label: "Perks", actual: 100, budget: 200, variance: -100, reported: true }],
  };

  it("renders summary + full with totals", () => {
    const m = buildPnlStatement(PAYLOAD);
    assert.equal(m.render, true);
    assert.equal(m.include_salary, true);
    // Summary excludes subs + tracked band.
    const subsInSummary = m.summary_rows.filter((r) => r.variant === "sub");
    assert.equal(subsInSummary.length, 0);
    const subsInFull = m.full_rows.filter((r) => r.variant === "sub");
    assert.equal(subsInFull.length, 2);
    // Tracked only in full.
    const trackedInSummary = m.summary_rows.filter((r) => r.variant === "tracked");
    assert.equal(trackedInSummary.length, 0);
    const trackedInFull = m.full_rows.filter((r) => r.variant === "tracked");
    assert.equal(trackedInFull.length, 1);
  });

  it("revenue row hatches Adjusted on closed", () => {
    const m = buildPnlStatement(PAYLOAD);
    const rev = m.full_rows.find((r) => r.line_code === "2400.1");
    assert.equal(rev.hatch_adjusted, true);
  });

  it("salary sub: ref=budget; Target % + Adjusted NOT hatched (R-99 superseded 2026-09-11)", () => {
    // Kevin CC prompt 2026-09-11.  Salary sub-rows render Target %
    // and Adjusted as real values (not hatched na-cells); ref_field
    // stays "budget" so variance ties to the fixed salary budget,
    // not the flex-adjusted amount.  Prior behaviour hatched both -
    // the 2026-11-20 strict-compare pass surfaced that v1 shipped
    // the un-hatched render and V2 was stale.
    const m = buildPnlStatement(PAYLOAD);
    const sal = m.full_rows.find((r) => r.line_code === "3100.2");
    assert.equal(sal.hatch_target_pct, false);
    assert.equal(sal.hatch_adjusted, false);
    assert.equal(sal.ref_field, "budget");
  });

  it("GM Adjusted from margin_at_this_revenue", () => {
    const m = buildPnlStatement(PAYLOAD);
    const gm = m.full_rows.find((r) => r.variant === "total" && r.label === "Gross margin");
    assert.equal(gm.adjusted, 50000);
  });

  it("inactive row has every cell null + inactive flag", () => {
    const m = buildPnlStatement({
      ...PAYLOAD,
      statement_rows: [
        { section: "revenue", line_code: "2400.2", label: "Away", flags: ["inactive"] },
      ],
    });
    const d = formatPnlStatement(m);
    const inactive = d.full_rows.find((r) => r.line_code === "2400.2");
    assert.equal(inactive.inactive, true);
    assert.equal(inactive.budget_display, null);
  });

  it("variance 'on budget' at < $1", () => {
    const payload = {
      ...PAYLOAD,
      statement_totals: {
        revenue: { budget_to_date: 100, actual: 100.4 },
        cogs: { budget_to_date: 50, budget_at_this_revenue: 50, actual: 50 },
        gross_margin: { budget_to_date: 50, margin_at_this_revenue: 50, actual: 50 },
      },
      statement_rows: [
        { section: "revenue", line_code: "2400.1", label: "Meals", budget_to_date: 100, actual: 100.4, reported: true, flags: [] },
        { section: "cogs", line_code: "3100", label: "Labor", budget_to_date: 50, target_pct: 50, budget_at_this_revenue: 50, actual: 50, reported: true, flags: [] },
      ],
      cards: [
        { key: "revenue", hero_actual: 100.4 },
        { key: "cogs", hero_actual: 50 },
        { key: "gross_margin", hero_actual: 50.4 },
      ],
    };
    const m = buildPnlStatement(payload);
    const d = formatPnlStatement(m);
    const cogsRow = d.full_rows.find((r) => r.line_code === "3100");
    assert.equal(cogsRow.variance_display, "on budget");
  });
});

// ─── WeekRail ─────────────────────────────────────────────────────

describe("WeekRail", () => {
  const PAYLOAD = {
    week_rail: {
      period_no: 9,
      running_week_no: 3,
      weeks: [
        { week_no: 1, week_start: "2026-08-10", week_end: "2026-08-16", state: "closed", revenue_basis: "confirmed",
          meal_revenue: 20000, fee_prorate: 5000, week_revenue: 25000, cost_target: 12500,
          cost_landed: 12000, labor_landed: 5000, purchasing_landed: 7000, unapproved_hours: 0 },
        { week_no: 2, week_start: "2026-08-17", week_end: "2026-08-23", state: "closed", revenue_basis: "confirmed",
          meal_revenue: 22000, fee_prorate: 5000, week_revenue: 27000, cost_target: 13500,
          cost_landed: 14000, labor_landed: 5500, purchasing_landed: 8500, unapproved_hours: 2.5 },
        { week_no: 3, week_start: "2026-08-24", week_end: "2026-08-30", state: "in_progress", revenue_basis: "confirmed",
          meal_revenue: 18000, fee_prorate: 5000, week_revenue: 23000, cost_target: 11500,
          cost_landed: 10000, labor_landed: 3000, purchasing_landed: 7000, unapproved_hours: 10 },
        { week_no: 4, week_start: "2026-08-31", week_end: "2026-09-06", state: "not_started", revenue_basis: "forecast",
          meal_revenue: 20000, fee_prorate: 5000, week_revenue: 25000, cost_target: 12500,
          cost_landed: 0, labor_landed: 0, purchasing_landed: 0, unapproved_hours: 0 },
      ],
    },
  };

  it("builds 4 tiles with running/confirmed/forecast variants", () => {
    const m = buildWeekRail(PAYLOAD);
    assert.equal(m.render, true);
    assert.equal(m.total_count, 4);
    assert.equal(m.confirmed_count, 2);     // weeks 1+2 are confirmed basis + not running
    assert.equal(m.tiles[0].variant, "confirmed");
    assert.equal(m.tiles[1].variant, "confirmed");
    assert.equal(m.tiles[2].variant, "running");
    assert.equal(m.tiles[3].variant, "forecast");
  });

  it("invoices_landed when (running - wk) >= 2", () => {
    const m = buildWeekRail(PAYLOAD);
    assert.equal(m.tiles[0].invoices_landed, true);   // 3-1 = 2
    assert.equal(m.tiles[1].invoices_landed, false);  // 3-2 = 1
  });

  it("labor caveats fire on pending + approved weeks", () => {
    const m = buildWeekRail(PAYLOAD);
    assert.equal(m.tiles[0].show_labor_approved_caveat, true);
    assert.equal(m.tiles[1].show_labor_pending_caveat, true);
    assert.equal(m.tiles[3].show_invoice_caveat, false);  // forecast
  });

  it("formatter: forecast tile vsline reads 'plan to'", () => {
    const d = formatWeekRail(buildWeekRail(PAYLOAD));
    assert.ok(d.tiles[3].vsline_display.startsWith("plan to"));
    assert.equal(d.tiles[3].cost_landed_display, "—");
  });

  it("no week_rail -> render false", () => {
    assert.equal(buildWeekRail({}).render, false);
  });
});

// ─── LaborLedger ──────────────────────────────────────────────────

describe("LaborLedger", () => {
  const LABOR = {
    actuals: [
      { worker_id: "w1", account_key: "TEST", week_start: "2026-08-10", week_end: "2026-08-16",
        hours_regular: 10, hours_overtime: 1, hours_double_time: 0, amount: 120,
        hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
      { worker_id: "w2", account_key: "TEST", week_start: "2026-08-10", week_end: "2026-08-16",
        hours_regular: 8, hours_overtime: 0, hours_double_time: 0, amount: 80,
        hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
      { worker_id: "w1", account_key: "TEST", week_start: "2026-08-17", week_end: "2026-08-23",
        hours_regular: 12, hours_overtime: 2, hours_double_time: 0, amount: 150,
        hours_without_dollars: 0, draft_hours: 4, coverage_state: "complete" },
    ],
    aggregate_excluded_members: [],
    workers: { w1: { display_name: "Alice", number: 1 }, w2: { display_name: "Bob", number: 2 } },
    board: {
      applies: true,
      avg_rate: 20,
      weeks: [
        { week_start: "2026-08-10", period_no: 9, fiscal_year: 2026, state: "closed", budget_at_this_week_revenue: 210 },
        { week_start: "2026-08-17", period_no: 9, fiscal_year: 2026, state: "closed", budget_at_this_week_revenue: 140 },
      ],
    },
  };

  it("builds ledger weeks with budget + variance", () => {
    const m = buildLaborLedger({
      labor: LABOR,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    assert.equal(m.render, true);
    assert.equal(m.weeks.length, 2);
    const w1 = m.weeks[0];
    assert.equal(w1.week_start, "2026-08-10");
    assert.equal(w1.hours, 19);      // 10+1+8+0
    assert.equal(w1.dollars, 200);
    assert.equal(w1.budget, 210);
    assert.equal(w1.variance_dollars, -10);
    assert.equal(w1.verdict, "good");
    const w2 = m.weeks[1];
    assert.equal(w2.hours, 14);
    assert.equal(w2.dollars, 150);
    assert.equal(w2.budget, 140);
    assert.equal(w2.variance_dollars, 10);
    assert.equal(w2.verdict, "bad");
    assert.equal(w2.unapproved_hours, 4);
  });

  it("missing labor -> render false", () => {
    const m = buildLaborLedger({
      labor: null,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    assert.equal(m.render, false);
  });

  it("header summary excludes drafts/unpriced", () => {
    const m = buildLaborLedger({
      labor: LABOR,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    // grand: single-period range so NOT isRunning (grouped.length === 1). Grand sums both weeks.
    assert.equal(m.header_summary.hours, 33);
    assert.equal(m.header_summary.dollars, 350);
    const d = formatLaborLedger(m);
    assert.equal(d.header_summary_display, "33 hrs · $350");
  });

  // ─── Train 2d-1 shape-fix additions (2026-11-20) ────────────────
  //
  // The DOM capture reads the LaborLedger fold's inner WeekTable
  // band + grand rows directly, so the model must carry the per-
  // pay-type dollar breakdown (Reg $, OT $, Hol $, Prem $, Salary,
  // Total) at 2-decimal precision — plus the per-week + per-worker
  // detail rows a downstream consumer can expand to.  The tests
  // below pin the arithmetic + formatting contract so a future
  // model change can't silently drift the fold's readout.

  const LABOR_BUCKETS = {
    actuals: [
      // Week 1: one hourly + one salaried.  Salary rides as
      // dollars_regular on the salaried row; the model must
      // subtract it back out for net_dollars_regular / Reg $.
      { worker_id: "w1", account_key: "TEST", week_start: "2026-08-10", week_end: "2026-08-16",
        hours_regular: 10, hours_overtime: 2, hours_double_time: 1, hours_premium_other: 0.5,
        dollars_regular: 200, dollars_overtime: 60, dollars_double_time: 40,
        dollars_premium_other: 15, amount: 315,
        hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
      { worker_id: "w2", account_key: "TEST", week_start: "2026-08-10", week_end: "2026-08-16",
        hours_regular: 0, hours_overtime: 0, hours_double_time: 0, hours_premium_other: 0,
        dollars_regular: 1000, dollars_overtime: 0, dollars_double_time: 0,
        dollars_premium_other: 0, amount: 1000,
        hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete",
        salaried: true },
      // Week 2: hourly only.
      { worker_id: "w1", account_key: "TEST", week_start: "2026-08-17", week_end: "2026-08-23",
        hours_regular: 8, hours_overtime: 0, hours_double_time: 0, hours_premium_other: 0,
        dollars_regular: 160, dollars_overtime: 0, dollars_double_time: 0,
        dollars_premium_other: 0, amount: 160,
        hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete" },
    ],
    aggregate_excluded_members: [],
    workers: {
      w1: { display_name: "Alice", number: 1, title: "Cook" },
      w2: { display_name: "Bob",   number: 2, title: "Chef" },
    },
    board: {
      applies: true,
      avg_rate: 20,
      weeks: [
        { week_start: "2026-08-10", period_no: 9, fiscal_year: 2026, state: "closed", budget_at_this_week_revenue: 1300 },
        { week_start: "2026-08-17", period_no: 9, fiscal_year: 2026, state: "closed", budget_at_this_week_revenue: 200 },
      ],
    },
  };

  it("per-week row carries per-pay-type dollar + hour breakdown", () => {
    const m = buildLaborLedger({
      labor: LABOR_BUCKETS,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    assert.equal(m.weeks.length, 2);
    const w1 = m.weeks[0];
    assert.equal(w1.hours_regular, 10);
    assert.equal(w1.hours_overtime, 2);
    assert.equal(w1.hours_double_time, 1);
    assert.equal(w1.hours_premium_other, 0.5);
    // dollars_regular is salary-inclusive on week 1 (w1 hourly $200
    // + w2 salaried $1,000).  net_dollars_regular reads the hourly-
    // only slice.
    assert.equal(w1.dollars_regular, 1200);
    assert.equal(w1.salary_amount, 1000);
    assert.equal(w1.net_dollars_regular, 200);
    assert.equal(w1.dollars_overtime, 60);
    assert.equal(w1.dollars_double_time, 40);
    assert.equal(w1.dollars_premium_other, 15);
    assert.equal(w1.total_dollars, 1315);
    const w2 = m.weeks[1];
    assert.equal(w2.hours_regular, 8);
    assert.equal(w2.salary_amount, 0);
    assert.equal(w2.net_dollars_regular, 160);
    assert.equal(w2.total_dollars, 160);
  });

  it("per-week row carries sorted per-worker rows", () => {
    const m = buildLaborLedger({
      labor: LABOR_BUCKETS,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    const w1 = m.weeks[0];
    assert.equal(w1.worker_rows.length, 2);
    // Bob first (amount desc).
    assert.equal(w1.worker_rows[0].worker_id, "w2");
    assert.equal(w1.worker_rows[0].salaried, true);
    assert.equal(w1.worker_rows[0].total_dollars, 1000);
    assert.equal(w1.worker_rows[0].title, "Chef");
    assert.equal(w1.worker_rows[1].worker_id, "w1");
    assert.equal(w1.worker_rows[1].total_dollars, 315);
    assert.equal(w1.worker_rows[1].hours_regular, 10);
  });

  it("period_bands sum per-week bucket figures and subtract salary for Reg $", () => {
    const m = buildLaborLedger({
      labor: LABOR_BUCKETS,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    assert.equal(m.period_bands.length, 1);
    const b = m.period_bands[0];
    assert.equal(b.period_no, 9);
    assert.equal(b.weeks_in_band, 2);
    assert.equal(b.hours_regular, 18);
    assert.equal(b.hours_overtime, 2);
    assert.equal(b.hours_double_time, 1);
    assert.equal(b.hours_premium_other, 0.5);
    assert.equal(b.dollars_regular, 1360);          // 1200 + 160
    assert.equal(b.salary_amount, 1000);
    assert.equal(b.net_dollars_regular, 360);       // 1360 - 1000
    assert.equal(b.dollars_overtime, 60);
    assert.equal(b.dollars_double_time, 40);
    assert.equal(b.dollars_premium_other, 15);
    assert.equal(b.total_dollars, 1475);            // 1315 + 160
  });

  it("grand row carries the same breakdown as the single band", () => {
    const m = buildLaborLedger({
      labor: LABOR_BUCKETS,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    assert.ok(m.grand);
    assert.equal(m.grand.hours_regular, 18);
    assert.equal(m.grand.hours_overtime, 2);
    assert.equal(m.grand.dollars_regular, 1360);
    assert.equal(m.grand.salary_amount, 1000);
    assert.equal(m.grand.net_dollars_regular, 360);
    assert.equal(m.grand.total_dollars, 1475);
  });

  it("formatter renders 2-decimal dollar + hour displays on the band", () => {
    const m = buildLaborLedger({
      labor: LABOR_BUCKETS,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    const d = formatLaborLedger(m);
    assert.equal(d.period_bands.length, 1);
    const b = d.period_bands[0];
    assert.equal(b.net_dollars_regular_display, "$360.00");
    assert.equal(b.dollars_overtime_display, "$60.00");
    assert.equal(b.dollars_double_time_display, "$40.00");
    assert.equal(b.dollars_premium_other_display, "$15.00");
    assert.equal(b.salary_display, "$1,000.00");
    assert.equal(b.total_display, "$1,475.00");
    assert.equal(b.hours_regular_display, "18.00");
    assert.equal(b.hours_overtime_display, "2.00");
  });

  it("formatter omits per-bucket cells below the 0.004 hour threshold", () => {
    // A row with all zero hours renders only the Total cell + salary.
    const SPARSE = {
      actuals: [
        { worker_id: "wS", account_key: "TEST", week_start: "2026-08-10", week_end: "2026-08-16",
          hours_regular: 0, hours_overtime: 0, hours_double_time: 0, hours_premium_other: 0,
          dollars_regular: 500, dollars_overtime: 0, dollars_double_time: 0,
          dollars_premium_other: 0, amount: 500,
          hours_without_dollars: 0, draft_hours: 0, coverage_state: "complete",
          salaried: true },
      ],
      aggregate_excluded_members: [],
      workers: { wS: { display_name: "Salaried", number: 9 } },
      board: {
        applies: true,
        weeks: [
          { week_start: "2026-08-10", period_no: 9, fiscal_year: 2026, state: "closed" },
        ],
      },
    };
    const m = buildLaborLedger({
      labor: SPARSE,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    const d = formatLaborLedger(m);
    const b = d.period_bands[0];
    assert.equal(b.net_dollars_regular_display, null);  // hours_regular is 0
    assert.equal(b.dollars_overtime_display, null);
    assert.equal(b.salary_display, "$500.00");
    assert.equal(b.total_display, "$500.00");
  });

  it("render false -> model carries empty period_bands + grand null", () => {
    const m = buildLaborLedger({
      labor: null,
      rangeSelection: { kind: "period", value: 9 },
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
    });
    assert.equal(m.render, false);
    assert.deepEqual(m.period_bands, []);
    assert.equal(m.grand, null);
    const d = formatLaborLedger(m);
    assert.equal(d.render, false);
    assert.deepEqual(d.period_bands, []);
    assert.equal(d.grand, null);
  });
});

// ─── PurchasingFold ───────────────────────────────────────────────

describe("PurchasingFold", () => {
  const PAYLOAD = {
    actuals: [
      // invoice_submissions · P9 week 1
      { source: "invoice_submissions", source_bill_id: "bill-1", vendor: "VendA", type: "invoice",
        gl_line_code: "3200.1", amount: 1500, txn_date: "2026-08-12", invoice_number: "INV-100" },
      { source: "invoice_submissions", source_bill_id: "bill-1", vendor: "VendA", type: "invoice",
        gl_line_code: "3400.1", amount: 300, txn_date: "2026-08-12" },
      // SG&A mixed
      { source: "invoice_submissions", source_bill_id: "bill-2", vendor: "VendB", type: "invoice",
        gl_line_code: "5000", amount: 200, txn_date: "2026-08-14", sga_removed_amount: 200 },
      { source: "invoice_submissions", source_bill_id: "bill-2", vendor: "VendB", type: "invoice",
        gl_line_code: "3200", amount: 500, txn_date: "2026-08-14" },
      // card charge · coded
      { source: "rippling_spend", source_bill_id: "card-1", vendor: "VendC",
        gl_line_code: "3200", amount: 100, txn_date: "2026-08-18", employee_name: "Alice" },
      // card charge · uncoded - dropped by Cards variant
      { source: "rippling_spend", source_bill_id: "card-2", vendor: "VendD",
        gl_line_code: null, amount: 50, txn_date: "2026-08-20" },
    ],
  };

  it("invoices variant: SG&A row dropped from columns but sga_removed carried", () => {
    const m = buildPurchasingFold({
      payload: PAYLOAD,
      variant: "invoices",
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
      fyStartISO: "2025-12-29",
    });
    assert.equal(m.render, true);
    // bill-1: food 1500 + pack 300 = 1800
    // bill-2: food 500 (SG&A line removed)
    const b1 = m.transactions.find((t) => t.source_bill_id === "bill-1");
    assert.equal(b1.food, 1500);
    assert.equal(b1.packaging, 300);
    assert.equal(b1.total, 1800);
    const b2 = m.transactions.find((t) => t.source_bill_id === "bill-2");
    assert.equal(b2.food, 500);
    assert.equal(b2.sga_removed, 200);
    // Cards excluded from invoices variant.
    assert.equal(m.transactions.find((t) => t.source === "rippling_spend"), undefined);
    assert.equal(m.foot.food, 2000);
    assert.equal(m.foot.packaging, 300);
  });

  it("cards variant: drops uncoded card groups", () => {
    const m = buildPurchasingFold({
      payload: PAYLOAD,
      variant: "cards",
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
      fyStartISO: "2025-12-29",
    });
    assert.equal(m.transactions.length, 1);
    assert.equal(m.transactions[0].source_bill_id, "card-1");
    assert.equal(m.foot.food, 100);
  });

  it("empty payload -> render false", () => {
    const m = buildPurchasingFold({
      payload: { actuals: [] },
      variant: "invoices",
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
      fyStartISO: "2025-12-29",
    });
    assert.equal(m.render, false);
  });

  it("formatter summary counts correctly", () => {
    const m = buildPurchasingFold({
      payload: PAYLOAD,
      variant: "invoices",
      start: "2026-08-10",
      end: "2026-09-06",
      today: "2026-09-07",
      fy: FY2026,
      fyStartISO: "2025-12-29",
    });
    const d = formatPurchasingFold(m);
    assert.equal(d.render, true);
    // 2 transactions in invoices variant (bill-1, bill-2)
    assert.ok(d.header_summary.includes("2 invoices"));
  });
});
