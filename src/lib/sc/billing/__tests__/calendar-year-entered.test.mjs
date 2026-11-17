// Year "days entered" counts a day that has any actuals line above 0,
// not just a meal. A day with only non-meal lines (pans, each, days)
// counts; a not-served day does not. Train 1b §6, Nov 16.

import test from "node:test";
import assert from "node:assert/strict";
import { loadCalendar } from "../../calendar/load.ts";

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function buildThirteen(p1Monday) {
  return Array.from({ length: 13 }, (_, i) => ({
    fiscal_year: 2026, period_no: i + 1,
    start_date: addDays(p1Monday, i * 28),
    end_date:   addDays(p1Monday, i * 28 + 27),
  }));
}

function makeSb({ services, revenue, today, finalize = [], meta = [] }) {
  return {
    rpc(name) {
      if (name === "sc_site_today") return Promise.resolve({ data: today, error: null });
      if (name === "sc_is_period_closed_fy") return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const asArr = (rows) => ({
        select() { return this; },
        eq() { return this; }, gte() { return this; }, lte() { return this; },
        neq() { return this; }, in() { return this; },
        order() { return this; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then(onF, onR) { return Promise.resolve({ data: rows, error: null }).then(onF, onR); },
      });
      if (table === "fiscal_periods") return asArr(buildThirteen("2026-01-05"));
      if (table === "sc_services") return asArr(services);
      if (table === "sc_qbo_account_map") return asArr([{ account_key: "R", cadence: "weekly", active: true }]);
      if (table === "sc_qbo_service_map") return asArr([]);
      if (table === "sc_day_metadata") return asArr(meta);
      if (table === "sc_week_finalize") return asArr(finalize);
      if (table === "sc_phase_calendar") return asArr([]);
      if (table === "sc_daily_revenue") {
        return {
          select(_cols, opts) {
            const wantCount = !!(opts && opts.count === "exact");
            let fromR = 0, toR = -1;
            const chain = {
              eq() { return chain; }, order() { return chain; },
              range(a, b) { fromR = a; toR = b; return chain; },
              then(onF, onR) {
                const payload = { data: revenue.slice(fromR, toR + 1), error: null };
                if (wantCount) payload.count = revenue.length;
                return Promise.resolve(payload).then(onF, onR);
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };
}

const VIEWER = {
  worker_id: "w", display_name: "V", role: "corporate",
  is_corp: true, is_regional_director: false, is_salaried: false,
  region: null, account_key: "", previewOf: null,
};
const SITE = {
  accountKey: "R", slug: "r", name: "R", region: null, level: null,
  isBilled: true, cadence: "weekly", timezone: null,
};

test("year entered: a day with only a non-meal line above 0 counts as entered", async () => {
  // One day, one service of unit=pans, actual_count=2. No meals.
  const services = [
    { id: "sv-pans", service_name: "Extra pans", unit: "pans", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null },
  ];
  const revenue = [
    { service_date: "2026-01-05", service_id: "sv-pans", is_flat_fee: false, is_non_revenue: false,
      actual_count: 2, actual_price_at_date: 50, price_at_date: 50, projected_count: 2,
      has_actuals: true, has_projection: true, actual_revenue: 100 },
  ];
  const sb = makeSb({ services, revenue, today: "2026-01-20" });
  const view = await loadCalendar({ sb, viewer: VIEWER, site: SITE, fiscalYear: 2026, periodNo: 1 });
  // One day with a non-meal line → entered = 1. Meals = 0 (no meal unit).
  assert.equal(view.year.totals.entered, 1, `entered should be 1 (the pans day), got ${view.year.totals.entered}`);
  assert.equal(view.year.totals.meals, 0, `meals should stay 0, got ${view.year.totals.meals}`);
});

test("year entered: a not-served day (every projected line at 0) does NOT count", async () => {
  const services = [
    { id: "sv-meals", service_name: "Lunch", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null },
  ];
  // Projected 10 meals, actuals row at 0: not-served.
  const revenue = [
    { service_date: "2026-01-05", service_id: "sv-meals", is_flat_fee: false, is_non_revenue: false,
      actual_count: 0, actual_price_at_date: 10, price_at_date: 10, projected_count: 10,
      has_actuals: true, has_projection: true, actual_revenue: 0 },
  ];
  const sb = makeSb({ services, revenue, today: "2026-01-20" });
  const view = await loadCalendar({ sb, viewer: VIEWER, site: SITE, fiscalYear: 2026, periodNo: 1 });
  assert.equal(view.year.totals.entered, 0, `a not-served day should not count as entered, got ${view.year.totals.entered}`);
});

test("year entered: meal-only days continue to count", async () => {
  const services = [
    { id: "sv-meals", service_name: "Lunch", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null },
  ];
  const revenue = [
    { service_date: "2026-01-05", service_id: "sv-meals", is_flat_fee: false, is_non_revenue: false,
      actual_count: 50, actual_price_at_date: 10, price_at_date: 10, projected_count: 50,
      has_actuals: true, has_projection: true, actual_revenue: 500 },
  ];
  const sb = makeSb({ services, revenue, today: "2026-01-20" });
  const view = await loadCalendar({ sb, viewer: VIEWER, site: SITE, fiscalYear: 2026, periodNo: 1 });
  assert.equal(view.year.totals.entered, 1);
  assert.equal(view.year.totals.meals, 50);
});
