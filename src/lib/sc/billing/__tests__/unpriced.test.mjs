// sc-60 (Kevin ruling 2026-11-16): a billed line with no real price
// stops the invoice build and names which service and which day.
// Train 2 part two-A ships the pure predicate + the builder refusal
// in one place (findUnpricedBillableLines + UnpricedLinesError in
// buildInvoicePayload.ts).
//
// What is tested here:
//   1. A meal line at price 0 stops the build and is named.
//   2. A meal line with a missing price does the same.
//   3. Two unpriced lines on different days are BOTH in the error.
//   4. A flat-fee row with any actuals at price 0 stops the build.
//   5. A non-revenue row at price 0 does not stop the build.
//   6. A meal row with actual_count of 0 does not stop the build.
//   7. An export-excluded row does not stop the build.
//   8. An unmapped row is skipped by the pure function (the
//      builder's own unmapped-service throw covers it).
//   9. Parity: findUnpricedBillableLines on a mixed input returns
//      the same list the builder's UnpricedLinesError carries.
//
// Run via: npm run test:sc

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInvoicePayload,
  findUnpricedBillableLines,
  UnpricedLinesError,
} from "../buildInvoicePayload.js";
import {
  TXR_AZ_ACCOUNT_MAP, TXR_AZ_SERVICE_MAP,
} from "./_helpers.mjs";

// Local scRow helper, matches the shape negative.test.mjs uses.
function scRow(partial) {
  return {
    service_date: partial.service_date,
    service_id:   partial.service_id,
    service_name: partial.service_name,
    account_key:  partial.account_key,
    is_flat_fee:  !!partial.is_flat_fee,
    is_tax_free:  !!partial.is_tax_free,
    is_non_revenue: !!partial.is_non_revenue,
    actual_count: partial.actual_count ?? null,
    actual_price_at_date: partial.price ?? null,
    price_at_date: partial.price ?? null,
    projected_count: partial.projected_count ?? null,
    period: partial.period ?? "8",
    week_label: partial.week_label ?? null,
    has_actuals: partial.actual_count != null,
    has_projection: partial.projected_count != null,
  };
}

const BREAKFAST = "5d626ec9-2505-470f-abe6-d7f3168ddf8f";
const LUNCH     = "3ec66570-b1dd-4189-a9ff-a0f9aba47797";
const CONTINENTAL = "6871d41e-08a8-4603-92c4-ba399a3a3674";

// 1. Meal at price 0: build is refused and the line is named.
test("unpriced: a meal line at price 0 stops the build and is named", () => {
  const rows = [
    scRow({
      service_date: "2026-07-27",
      service_id: BREAKFAST, service_name: "Breakfast",
      account_key: "TXR - AZ",
      actual_count: 100, price: 0,
      period: "8", week_label: "Week 3",
    }),
  ];
  assert.throws(
    () => buildInvoicePayload({
      accountKey: "TXR - AZ", weekStart: "2026-07-27",
      rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: TXR_AZ_SERVICE_MAP,
    }),
    (err) => {
      assert.ok(err instanceof UnpricedLinesError, "throws UnpricedLinesError");
      assert.equal(err.code, "UNPRICED_LINES");
      assert.equal(err.lines.length, 1);
      assert.equal(err.lines[0].service_id, BREAKFAST);
      assert.equal(err.lines[0].service_name, "Breakfast");
      assert.equal(err.lines[0].service_date, "2026-07-27");
      return true;
    }
  );
});

// 2. Meal with null price: same.
test("unpriced: a meal line with null price stops the build and is named", () => {
  const rows = [
    scRow({
      service_date: "2026-07-27",
      service_id: BREAKFAST, service_name: "Breakfast",
      account_key: "TXR - AZ",
      actual_count: 100, price: null,
      period: "8", week_label: "Week 3",
    }),
  ];
  assert.throws(
    () => buildInvoicePayload({
      accountKey: "TXR - AZ", weekStart: "2026-07-27",
      rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: TXR_AZ_SERVICE_MAP,
    }),
    (err) => {
      assert.ok(err instanceof UnpricedLinesError);
      assert.equal(err.lines.length, 1);
      assert.equal(err.lines[0].service_id, BREAKFAST);
      return true;
    }
  );
});

// 3. Two unpriced on different days: both in the error.
test("unpriced: two unpriced lines on different days are both in the error", () => {
  const rows = [
    scRow({
      service_date: "2026-07-27",
      service_id: BREAKFAST, service_name: "Breakfast",
      account_key: "TXR - AZ",
      actual_count: 50, price: 0,
      period: "8", week_label: "Week 3",
    }),
    scRow({
      service_date: "2026-07-29",
      service_id: LUNCH, service_name: "Lunch",
      account_key: "TXR - AZ",
      actual_count: 40, price: null,
      period: "8", week_label: "Week 3",
    }),
  ];
  assert.throws(
    () => buildInvoicePayload({
      accountKey: "TXR - AZ", weekStart: "2026-07-27",
      rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: TXR_AZ_SERVICE_MAP,
    }),
    (err) => {
      assert.ok(err instanceof UnpricedLinesError);
      assert.equal(err.lines.length, 2);
      const ids = err.lines.map((l) => l.service_id).sort();
      assert.deepEqual(ids, [LUNCH, BREAKFAST].sort());
      const dates = err.lines.map((l) => l.service_date).sort();
      assert.deepEqual(dates, ["2026-07-27", "2026-07-29"]);
      return true;
    }
  );
});

// 4. Flat-fee row at price 0: the FF line is unpriced, build stops.
test("unpriced: a flat-fee row at price 0 stops the build", () => {
  // Use a flat-fee-mapped service_id: Continental Breakfast is not
  // flat-fee in the real map, so for this test we build a one-off
  // service map that marks it is_flat_fee on the row side and keeps
  // its mapping present.
  const rows = [
    scRow({
      service_date: "2026-07-27",
      service_id: CONTINENTAL, service_name: "Continental",
      account_key: "TXR - AZ",
      is_flat_fee: true,
      actual_count: 0, price: 0,
      period: "8", week_label: "Week 3",
    }),
  ];
  assert.throws(
    () => buildInvoicePayload({
      accountKey: "TXR - AZ", weekStart: "2026-07-27",
      rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: TXR_AZ_SERVICE_MAP,
    }),
    (err) => {
      assert.ok(err instanceof UnpricedLinesError);
      assert.equal(err.lines.length, 1);
      assert.equal(err.lines[0].service_id, CONTINENTAL);
      return true;
    }
  );
});

// 5. Non-revenue row at price 0: does NOT stop the build.
test("unpriced: a non-revenue row at price 0 does not stop the build", () => {
  const rows = [
    // Priced meal row so the invoice has at least one line.
    scRow({
      service_date: "2026-07-27",
      service_id: BREAKFAST, service_name: "Breakfast",
      account_key: "TXR - AZ",
      actual_count: 100, price: 14.2926,
      period: "8", week_label: "Week 3",
    }),
    // Non-revenue row at 0 - dropped before the unpriced check.
    scRow({
      service_date: "2026-07-27",
      service_id: "99999999-9999-9999-9999-999999999999",
      service_name: "Fun $$$$ Allocated",
      account_key: "TXR - AZ",
      is_non_revenue: true,
      actual_count: 50, price: 0,
      period: "8", week_label: "Week 3",
    }),
  ];
  const { invoices } = buildInvoicePayload({
    accountKey: "TXR - AZ", weekStart: "2026-07-27",
    rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: TXR_AZ_SERVICE_MAP,
  });
  assert.equal(invoices.length, 1);
});

// 6. Meal row with count of 0: does NOT stop the build (no line produced).
test("unpriced: a meal row with actual_count of 0 does not stop the build", () => {
  const rows = [
    scRow({
      service_date: "2026-07-27",
      service_id: BREAKFAST, service_name: "Breakfast",
      account_key: "TXR - AZ",
      actual_count: 100, price: 14.2926,
      period: "8", week_label: "Week 3",
    }),
    // Zero-count meal: no line produced, price does not matter.
    scRow({
      service_date: "2026-07-27",
      service_id: LUNCH, service_name: "Lunch",
      account_key: "TXR - AZ",
      actual_count: 0, price: 0,
      period: "8", week_label: "Week 3",
    }),
  ];
  const { invoices } = buildInvoicePayload({
    accountKey: "TXR - AZ", weekStart: "2026-07-27",
    rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: TXR_AZ_SERVICE_MAP,
  });
  assert.equal(invoices.length, 1);
});

// 7. Export-excluded row at price 0: does NOT stop the build.
test("unpriced: an export-excluded row does not stop the build", () => {
  const svcMap = TXR_AZ_SERVICE_MAP.map((s) =>
    s.service_id === LUNCH ? { ...s, export_excluded: true } : s
  );
  const rows = [
    scRow({
      service_date: "2026-07-27",
      service_id: BREAKFAST, service_name: "Breakfast",
      account_key: "TXR - AZ",
      actual_count: 100, price: 14.2926,
      period: "8", week_label: "Week 3",
    }),
    // Export-excluded row at 0: dropped before the unpriced check.
    scRow({
      service_date: "2026-07-27",
      service_id: LUNCH, service_name: "Lunch",
      account_key: "TXR - AZ",
      actual_count: 50, price: 0,
      period: "8", week_label: "Week 3",
    }),
  ];
  const { invoices } = buildInvoicePayload({
    accountKey: "TXR - AZ", weekStart: "2026-07-27",
    rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: svcMap,
  });
  assert.equal(invoices.length, 1);
});

// 8. Unmapped row: pure function skips (builder's own throw covers).
test("unpriced: an unmapped row is skipped by findUnpricedBillableLines", () => {
  const rows = [
    scRow({
      service_date: "2026-07-27",
      service_id: "11111111-1111-1111-1111-111111111111",
      service_name: "Mystery Service",
      account_key: "TXR - AZ",
      actual_count: 10, price: 0,
      period: "8", week_label: "Week 3",
    }),
  ];
  const unpriced = findUnpricedBillableLines(rows, TXR_AZ_SERVICE_MAP);
  assert.equal(unpriced.length, 0, "unmapped row is not flagged as unpriced");
});

// 9. Parity: the pure function and the builder agree on a mixed input.
test("unpriced: findUnpricedBillableLines returns the same list the builder throws", () => {
  const rows = [
    // Priced meal (not flagged)
    scRow({ service_date: "2026-07-27", service_id: BREAKFAST, service_name: "Breakfast",
            account_key: "TXR - AZ", actual_count: 100, price: 14.2926,
            period: "8", week_label: "Week 3" }),
    // Unpriced meal (flagged)
    scRow({ service_date: "2026-07-28", service_id: LUNCH, service_name: "Lunch",
            account_key: "TXR - AZ", actual_count: 50, price: 0,
            period: "8", week_label: "Week 3" }),
    // Zero-count meal (not flagged - no line produced)
    scRow({ service_date: "2026-07-29", service_id: LUNCH, service_name: "Lunch",
            account_key: "TXR - AZ", actual_count: 0, price: 0,
            period: "8", week_label: "Week 3" }),
    // Non-revenue (not flagged - dropped)
    scRow({ service_date: "2026-07-30", service_id: "99999999-9999-9999-9999-999999999999",
            service_name: "Fun", account_key: "TXR - AZ", is_non_revenue: true,
            actual_count: 50, price: 0, period: "8", week_label: "Week 3" }),
    // Second unpriced meal on a later day (flagged)
    scRow({ service_date: "2026-07-31", service_id: CONTINENTAL, service_name: "Continental",
            account_key: "TXR - AZ", actual_count: 20, price: null,
            period: "8", week_label: "Week 3" }),
  ];
  const fromFn = findUnpricedBillableLines(rows, TXR_AZ_SERVICE_MAP);
  let fromBuilder = null;
  try {
    buildInvoicePayload({
      accountKey: "TXR - AZ", weekStart: "2026-07-27",
      rows, accountMap: TXR_AZ_ACCOUNT_MAP, serviceMap: TXR_AZ_SERVICE_MAP,
    });
  } catch (err) {
    assert.ok(err instanceof UnpricedLinesError, "builder throws UnpricedLinesError");
    fromBuilder = err.lines;
  }
  assert.ok(fromBuilder, "builder did throw");
  assert.deepEqual(
    [...fromFn].sort((a, b) => a.service_date.localeCompare(b.service_date)),
    [...fromBuilder].sort((a, b) => a.service_date.localeCompare(b.service_date)),
    "pure function and builder agree on the unpriced set"
  );
});
