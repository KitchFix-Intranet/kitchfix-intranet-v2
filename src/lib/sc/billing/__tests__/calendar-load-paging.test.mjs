// sc_daily_revenue is paged with .range() and an exact-count
// assertion. The 1000-row cap must not silently truncate the year.
// This test runs the calendar loader against a hand-rolled supa that
// returns > 1000 rows across multiple pages, and asserts that every
// row lands.

import test from "node:test";
import assert from "node:assert/strict";
import { loadCalendar } from "../../calendar/load.ts";

// Make N synthetic rows across the FY (365 days * 4 services = 1460).
function fakeRevenueRows() {
  const rows = [];
  const start = new Date(Date.UTC(2026, 10, 2)); // Nov 2, 2026 - current period
  for (let i = 0; i < 365; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    for (let s = 0; s < 4; s++) {
      rows.push({
        service_date: iso,
        service_id: `svc-${s}`,
        is_flat_fee: false,
        is_non_revenue: false,
        actual_count: 10,
        actual_price_at_date: 12.5,
        price_at_date: 12.5,
        projected_count: 10,
        has_actuals: true,
        has_projection: true,
        actual_revenue: 125,
      });
    }
  }
  return rows;
}

// A minimal supa that implements only what the loader needs.
function makeSupaForPaging() {
  const revenue = fakeRevenueRows();
  const metadata = [];
  const periods = Array.from({ length: 13 }, (_, i) => ({
    fiscal_year: 2026, period_no: i + 1,
    start_date: addDays("2025-12-29", i * 28),
    end_date:   addDays("2025-12-29", i * 28 + 27),
  }));
  const services = [
    { id: "svc-0", service_name: "A", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null },
    { id: "svc-1", service_name: "B", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null },
    { id: "svc-2", service_name: "C", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null },
    { id: "svc-3", service_name: "D", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null },
  ];
  const finalize = [];
  const phases = [];
  const sawRangeCalls = [];

  const sb = {
    rpc(name) {
      if (name === "sc_site_today") return Promise.resolve({ data: "2026-11-16", error: null });
      if (name === "sc_is_period_closed_fy") return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      if (table === "fiscal_periods") return pickChain(periods, ["fiscal_year", "period_no", "start_date", "end_date"]);
      if (table === "sc_services") return servicesChain(services);
      if (table === "sc_qbo_account_map") return singleChain({ account_key: "SYN - TEST", cadence: "weekly", active: true });
      if (table === "sc_qbo_service_map") return arrayChain([]);
      if (table === "sc_daily_revenue") return pagingChain(revenue, sawRangeCalls);
      if (table === "sc_day_metadata") return arrayChain(metadata);
      if (table === "sc_week_finalize") return arrayChain(finalize);
      if (table === "sc_phase_calendar") return arrayChain(phases);
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { sb, totalRows: revenue.length, sawRangeCalls };
}

function singleChain(row) {
  const c = {
    select() { return c; }, eq() { return c; },
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return c;
}
function arrayChain(rows) {
  const c = {
    select() { return c; }, eq() { return c; }, gte() { return c; }, lte() { return c; },
    neq() { return c; }, in() { return c; },
    order() { return c; },
    then(onF, onR) { return Promise.resolve({ data: rows, error: null }).then(onF, onR); },
  };
  return c;
}
function servicesChain(rows) {
  const c = {
    select() { return c; }, eq() { return c; },
    then(onF, onR) { return Promise.resolve({ data: rows, error: null }).then(onF, onR); },
  };
  return c;
}
function pickChain(rows, columns) {
  const c = {
    select() { return c; }, eq() { return c; }, order() { return c; },
    then(onF, onR) {
      const picked = rows.map((r) => Object.fromEntries(columns.map((k) => [k, r[k]])));
      return Promise.resolve({ data: picked, error: null }).then(onF, onR);
    },
  };
  return c;
}

// The paged supa chain. Supports .range(start, end), returns the slice
// with the exact count on the first page.
function pagingChain(rows, sawRangeCalls) {
  let from = 0, to = -1;
  let wantCount = false;
  const c = {
    select(_cols, opts) { if (opts && opts.count === "exact") wantCount = true; return c; },
    eq() { return c; }, gte() { return c; }, lte() { return c; },
    order() { return c; },
    range(a, b) { from = a; to = b; sawRangeCalls.push([a, b]); return c; },
    then(onF, onR) {
      const slice = rows.slice(from, to + 1);
      const payload = { data: slice, error: null };
      if (wantCount) payload.count = rows.length;
      wantCount = false;
      return Promise.resolve(payload).then(onF, onR);
    },
  };
  return c;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function buildThirteen(p1Monday) {
  return Array.from({ length: 13 }, (_, i) => ({
    fiscal_year: 2026,
    period_no: i + 1,
    start_date: addDays(p1Monday, i * 28),
    end_date:   addDays(p1Monday, i * 28 + 27),
  }));
}

test("load paging: a FY with > 1000 revenue rows comes back whole", async () => {
  const { sb, totalRows, sawRangeCalls } = makeSupaForPaging();
  const view = await loadCalendar({
    sb,
    viewer: {
      worker_id: "w1", display_name: "V", role: "corporate",
      is_corp: true, is_regional_director: false, is_salaried: false,
      region: null, account_key: "", previewOf: null,
    },
    site: {
      accountKey: "SYN - TEST", slug: "syn-test", name: "Synthetic", region: "East", level: "PDC",
      isBilled: true, cadence: "weekly", timezone: null,
    },
    fiscalYear: 2026,
    periodNo: 12,
  });
  // The total should be visible to the loader as 1460.
  assert.equal(totalRows, 365 * 4);
  // At least two range calls (0..999, then 1000..1999).
  assert.ok(sawRangeCalls.length >= 2, `expected multiple range() calls, saw ${sawRangeCalls.length}`);
  assert.deepEqual(sawRangeCalls[0], [0, 999]);
  // The second page bounds its end to (count - 1), not a raw PAGE_SIZE-1
  // step, so one extra round trip to a mostly-empty final page is
  // avoided. For 1460 total that means [1000, 1459].
  assert.deepEqual(sawRangeCalls[1], [1000, totalRows - 1]);
  // The current period should be populated without throwing.
  assert.equal(view.period.weeks.length, 4);
  // The year should have 13 cards.
  assert.equal(view.year.cards.length, 13);
});

test("load paging: a two-week submit does NOT sum the pair's dollars on both weeks", async () => {
  // Build a tiny FY with just one period of four weeks. Week 1 and
  // week 2 of the first pair each carry different revenue. A single
  // finalize row anchored at week 2 Monday (biweekly W2) covers both
  // weeks via the engine helper's 14-day span. The loader must sum
  // ONLY this week's own seven dates for the dollars.
  const W1_MONDAY = "2026-01-05";
  const W2_MONDAY = "2026-01-12";
  const revenue = [];
  // Week 1: $100 per day Mon..Fri = $500
  for (const d of ["2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09"]) {
    revenue.push({ service_date: d, service_id: "s1", is_flat_fee: false, is_non_revenue: false, actual_count: 10, actual_price_at_date: 10, price_at_date: 10, projected_count: 10, has_actuals: true, has_projection: true, actual_revenue: 100 });
  }
  // Week 2: $200 per day Mon..Fri = $1000
  for (const d of ["2026-01-12","2026-01-13","2026-01-14","2026-01-15","2026-01-16"]) {
    revenue.push({ service_date: d, service_id: "s1", is_flat_fee: false, is_non_revenue: false, actual_count: 10, actual_price_at_date: 20, price_at_date: 20, projected_count: 10, has_actuals: true, has_projection: true, actual_revenue: 200 });
  }
  const periods = [
    { fiscal_year: 2026, period_no: 1, start_date: W1_MONDAY, end_date: "2026-02-01" },
  ];
  const services = [{ id: "s1", service_name: "Meal", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null }];
  const meta = [
    { account_key: "RED - X", service_date: W1_MONDAY, week_label: "Week 1" },
    { account_key: "RED - X", service_date: W2_MONDAY, week_label: "Week 2" },
  ];
  const finalize = [
    { id: "f1", week_start: W2_MONDAY, status: "finalized", finalized_at: "2026-01-19T18:00:00Z", push_attempts: 0, push_done_at: "2026-01-19T18:00:10Z", push_gave_up_at: null },
  ];
  const sb = {
    rpc(name, args) {
      if (name === "sc_site_today") return Promise.resolve({ data: "2026-01-20", error: null });
      if (name === "sc_is_period_closed_fy") return Promise.resolve({ data: args.p_period_no < 1, error: null });
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
      if (table === "fiscal_periods") {
        return asArr(buildThirteen(W1_MONDAY));
      }
      if (table === "sc_services") return asArr(services);
      if (table === "sc_qbo_account_map") return asArr([{ account_key: "RED - X", cadence: "biweekly", active: true }]);
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
                const slice = revenue.slice(fromR, toR + 1);
                const payload = { data: slice, error: null };
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
  const view = await loadCalendar({
    sb,
    viewer: { worker_id: "w", display_name: "V", role: "corporate", is_corp: true, is_regional_director: false, is_salaried: false, region: null, account_key: "", previewOf: null },
    site: { accountKey: "RED - X", slug: "red-x", name: "Red X", region: null, level: null, isBilled: true, cadence: "biweekly", timezone: null },
    fiscalYear: 2026,
    periodNo: 1,
  });
  const w1 = view.period.weeks[0];
  const w2 = view.period.weeks[1];
  assert.equal(w1.state, "submitted", "week 1 covered by the 14-day span");
  assert.equal(w2.state, "submitted", "week 2 the anchor");
  // Week 1's own five weekdays total $500 (50000 cents). Week 2's $1000.
  assert.equal(w1.billableCents, 50000, `week 1 own-dollars; got ${w1.billableCents}`);
  assert.equal(w2.billableCents, 100000, `week 2 own-dollars; got ${w2.billableCents}`);
  // Different numbers on the two weeks is the acceptance.
  assert.notEqual(w1.billableCents, w2.billableCents);
});

test("load paging: an open biweekly first-week on the Monday after its own Sunday is NOT still-open while the second week is running", async () => {
  // Biweekly, week 1 ends Jan 11 Sun; today is Jan 12 Mon (inside week 2).
  // The pair unit ends Jan 18 Sun, which is AFTER today.
  // Week 1 is OPEN (no finalize row yet) and has entered days.
  // Expectation: week 1 does NOT read "still_open" because the pair
  // unit has not ended yet. It should read "entered".
  const services = [{ id: "s1", service_name: "Meal", unit: "meals", is_flat_fee: false, is_non_revenue: false, active: true, active_until: null }];
  const revenue = [];
  for (const d of ["2026-01-05","2026-01-06","2026-01-07","2026-01-08","2026-01-09"]) {
    revenue.push({ service_date: d, service_id: "s1", is_flat_fee: false, is_non_revenue: false, actual_count: 10, actual_price_at_date: 10, price_at_date: 10, projected_count: 10, has_actuals: true, has_projection: true, actual_revenue: 100 });
  }
  const meta = [
    { account_key: "RED - X", service_date: "2026-01-05", week_label: "Week 1" },
    { account_key: "RED - X", service_date: "2026-01-12", week_label: "Week 2" },
  ];
  const sb = {
    rpc(name) {
      if (name === "sc_site_today") return Promise.resolve({ data: "2026-01-12", error: null });
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
      if (table === "fiscal_periods") {
        return asArr(buildThirteen("2026-01-05"));
      }
      if (table === "sc_services") return asArr(services);
      if (table === "sc_qbo_account_map") return asArr([{ account_key: "RED - X", cadence: "biweekly", active: true }]);
      if (table === "sc_qbo_service_map") return asArr([]);
      if (table === "sc_day_metadata") return asArr(meta);
      if (table === "sc_week_finalize") return asArr([]);
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
  const view = await loadCalendar({
    sb,
    viewer: { worker_id: "w", display_name: "V", role: "corporate", is_corp: true, is_regional_director: false, is_salaried: false, region: null, account_key: "", previewOf: null },
    site: { accountKey: "RED - X", slug: "red-x", name: "Red X", region: null, level: null, isBilled: true, cadence: "biweekly", timezone: null },
    fiscalYear: 2026,
    periodNo: 1,
  });
  const w1 = view.period.weeks[0];
  assert.notEqual(w1.state, "still_open", "w1 not still_open while the pair unit is still running");
});

test("load paging: a count mismatch throws loud", async () => {
  // Rig a supa that reports a count of 500 but only returns 10 rows,
  // so the loader's assertion fires.
  const revenue = fakeRevenueRows();
  const lying = {
    rpc(name) {
      if (name === "sc_site_today") return Promise.resolve({ data: "2026-11-16", error: null });
      return Promise.resolve({ data: false, error: null });
    },
    from(table) {
      if (table === "fiscal_periods") return pickChain([
        { fiscal_year: 2026, period_no: 1, start_date: "2025-12-29", end_date: "2026-01-25" },
      ], ["fiscal_year", "period_no", "start_date", "end_date"]);
      if (table === "sc_services") return servicesChain([]);
      if (table === "sc_qbo_account_map") return singleChain(null);
      if (table === "sc_qbo_service_map") return arrayChain([]);
      if (table === "sc_day_metadata") return arrayChain([]);
      if (table === "sc_week_finalize") return arrayChain([]);
      if (table === "sc_phase_calendar") return arrayChain([]);
      if (table === "sc_daily_revenue") {
        return {
          select(_c, opts) {
            const wantCount = !!(opts && opts.count === "exact");
            const c = {
              eq() { return c; }, gte() { return c; }, lte() { return c; }, order() { return c; },
              range() { return c; },
              then(onF, onR) {
                const payload = { data: revenue.slice(0, 10), error: null };
                if (wantCount) payload.count = 500;
                return Promise.resolve(payload).then(onF, onR);
              },
            };
            return c;
          },
        };
      }
      throw new Error(`unexpected ${table}`);
    },
  };
  await assert.rejects(
    () => loadCalendar({
      sb: lying,
      viewer: {
        worker_id: "w1", display_name: "V", role: "corporate",
        is_corp: true, is_regional_director: false, is_salaried: false,
        region: null, account_key: "", previewOf: null,
      },
      site: { accountKey: "SYN - TEST", slug: "syn-test", name: "Syn", region: null, level: null, isBilled: false, cadence: "weekly", timezone: null },
      fiscalYear: 2026,
      periodNo: 1,
    }),
    /paging: expected|fiscal_periods: expected 13 rows/,
  );
});
