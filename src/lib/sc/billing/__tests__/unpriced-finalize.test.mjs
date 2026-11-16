// sc-60 integration: runFinalizeEffects reports an unpriced line as
// failure code "UNPRICED_LINES" with the list, through the same path
// BUILD_ERROR takes today.
//
// Run via: npm run test:sc

import test from "node:test";
import assert from "node:assert/strict";
import { runFinalizeEffects } from "../../scWeekFinalize.ts";
import { makeSupaMock } from "./_supa-mock.mjs";

const TXR_MAP = {
  account_key: "TXR - AZ",
  qbo_customer_id: "19000",
  qbo_customer_name: "Texas Rangers - Surprise, AZ",
  qbo_taxcode_id: "36",
  qbo_class_id: "1200000000000411132",
  cadence: "weekly",
  qbo_mode: "test",
  salaried_manager_emails: [],
  rdo_email: null,
  active: true,
};

function baseCtx() {
  return {
    accountKey: "TXR - AZ",
    weekStart: "2026-07-27",
    finalizedRow: {
      id: "fin-row-1",
      account_key: "TXR - AZ",
      week_start: "2026-07-27",
      status: "finalized",
      finalized_by: "leader@kitchfix.com",
    },
  };
}

function makeSeedTables({ revenueRows }) {
  return {
    people: [],
    sc_qbo_account_map: [TXR_MAP],
    sc_qbo_service_map: [
      { service_id: "svc-1", account_key: "TXR - AZ", qbo_item_id: "3338",
        qbo_line_description: "TXR-AZ - Regular Snack", aggregate_group: null,
        invoice_slot: "main", tax_override: null, line_desc_style: null, active: true },
    ],
    sc_invoice_slot_codes: [{ account_key: "TXR - AZ", invoice_slot: "main", slot_code: "MN" }],
    sc_daily_revenue: revenueRows,
    sc_week_finalize: [{
      id: "fin-row-1", account_key: "TXR - AZ", week_start: "2026-07-27",
      status: "finalized", finalized_by: "leader@kitchfix.com",
    }],
    sc_export_ledger: [],
  };
}

test("UNPRICED_LINES: finalize on a week with a zero-price line fails with the list", async () => {
  const supa = makeSupaMock({
    tables: makeSeedTables({
      revenueRows: [
        {
          service_date: "2026-07-27", service_id: "svc-1", service_name: "Regular Snack",
          account_key: "TXR - AZ", is_flat_fee: false, is_tax_free: false,
          is_non_revenue: false, actual_count: 10,
          actual_price_at_date: 0, price_at_date: 0,       // UNPRICED
          period: "8", week_label: "Week 3",
          has_actuals: true, has_projection: false,
        },
      ],
    }),
  });

  let n2Args = null;
  let postCalled = false;
  const deps = {
    supa,
    postInvoiceDraft: async () => { postCalled = true; return { wasNoOp: false, ledgerRowId: "x", status: "test" }; },
    fireN1: async () => { throw new Error("N1 must not fire on failure"); },
    fireN2: async (args) => {
      n2Args = args;
      return {
        recipients: { to: ["kevin@kitchfix.com"], cc: [] },
        subject: "[TEST] push failed", preheader: "", html: "",
        email: { result: "sent" },
        slack: { text: "", result: { sent: true } },
      };
    },
    logger: { info: () => {}, warn: () => {} },
  };

  const result = await runFinalizeEffects(baseCtx(), deps);
  assert.equal(result.pushed, false);
  assert.equal(result.failure.code, "UNPRICED_LINES",
    "failure code is UNPRICED_LINES, not BUILD_ERROR");
  assert.ok(Array.isArray(result.failure.unpricedLines), "unpricedLines list is present on the failure");
  assert.equal(result.failure.unpricedLines.length, 1);
  assert.equal(result.failure.unpricedLines[0].service_id, "svc-1");
  assert.equal(result.failure.unpricedLines[0].service_date, "2026-07-27");
  assert.equal(postCalled, false, "nothing posted");
  assert.ok(n2Args, "N2 still fires on the same path BUILD_ERROR takes today");
  assert.match(result.failure.message, /no price/i);
});

test("UNPRICED_LINES: finalize does not write a ledger row on the failure", async () => {
  const supa = makeSupaMock({
    tables: makeSeedTables({
      revenueRows: [
        {
          service_date: "2026-07-27", service_id: "svc-1", service_name: "Regular Snack",
          account_key: "TXR - AZ", is_flat_fee: false, is_tax_free: false,
          is_non_revenue: false, actual_count: 10,
          actual_price_at_date: null, price_at_date: null,  // UNPRICED (null)
          period: "8", week_label: "Week 3",
          has_actuals: true, has_projection: false,
        },
      ],
    }),
  });

  const deps = {
    supa,
    postInvoiceDraft: async () => { throw new Error("post must not run"); },
    fireN1: async () => { throw new Error("N1 must not fire"); },
    fireN2: async () => ({
      recipients: { to: ["kevin@kitchfix.com"], cc: [] },
      subject: "[TEST] push failed", preheader: "", html: "",
      email: { result: "sent" },
      slack: { text: "", result: { sent: true } },
    }),
    logger: { info: () => {}, warn: () => {} },
  };

  const result = await runFinalizeEffects(baseCtx(), deps);
  assert.equal(result.failure.code, "UNPRICED_LINES");
  const ledger = supa._dump("sc_export_ledger");
  assert.equal(ledger.length, 0, "the ledger is untouched");
});
