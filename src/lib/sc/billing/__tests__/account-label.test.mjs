// sc-62 (Kevin ruling 2026-11-16): the account label is read from
// the column that exists. The engine's lookup today asks for
// `accounts.team_name`; the column is `name`. This test asserts
// the finalize path reads the real column and that the fallback
// still fires on a miss.
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

function makeSeedTables({ accounts }) {
  return {
    people: [],
    accounts,
    sc_qbo_account_map: [TXR_MAP],
    sc_qbo_service_map: [
      { service_id: "svc-1", account_key: "TXR - AZ", qbo_item_id: "3338",
        qbo_line_description: "TXR-AZ - Regular Snack", aggregate_group: null,
        invoice_slot: "main", tax_override: null, line_desc_style: null, active: true },
    ],
    sc_invoice_slot_codes: [{ account_key: "TXR - AZ", invoice_slot: "main", slot_code: "MN" }],
    sc_daily_revenue: [
      { service_date: "2026-07-27", service_id: "svc-1", service_name: "Regular Snack",
        account_key: "TXR - AZ", is_flat_fee: false, is_tax_free: false,
        is_non_revenue: false, actual_count: 10, actual_price_at_date: 5.89,
        price_at_date: 5.89, period: "8", week_label: "Week 3",
        has_actuals: true, has_projection: false },
    ],
    sc_week_finalize: [{
      id: "fin-row-1", account_key: "TXR - AZ", week_start: "2026-07-27",
      status: "finalized", finalized_by: "leader@kitchfix.com",
    }],
    sc_export_ledger: [],
  };
}

test("account label: the label comes back from accounts.name", async () => {
  const supa = makeSupaMock({
    tables: makeSeedTables({
      accounts: [{ team_key: "TXR - AZ", name: "Texas Rangers" }],
    }),
  });

  let n1Args = null;
  const deps = {
    supa,
    postInvoiceDraft: async () => ({ wasNoOp: false, ledgerRowId: "x", status: "test",
                                     qboInvoiceId: "TEST-9", qboDocNumber: "KFTxx" }),
    fireN1: async (args) => {
      n1Args = args;
      return {
        recipients: { to: ["kevin@kitchfix.com"], cc: [] },
        subject: "[TEST] ...", preheader: "", html: "",
        email: { result: "sent" },
        slack: { text: "", result: { sent: true } },
      };
    },
    fireN2: async () => { throw new Error("N2 must not fire"); },
    logger: { info: () => {}, warn: () => {} },
  };

  const result = await runFinalizeEffects(baseCtx(), deps);
  assert.equal(result.pushed, true);
  assert.equal(n1Args.accountLabel, "Texas Rangers",
    "accountLabel comes from accounts.name, matched on team_key");
});

test("account label: a miss falls back to null, as the lookup does today", async () => {
  const supa = makeSupaMock({
    tables: makeSeedTables({
      accounts: [{ team_key: "OTHER", name: "Not TXR" }],   // No row for TXR - AZ.
    }),
  });

  let n1Args = null;
  const deps = {
    supa,
    postInvoiceDraft: async () => ({ wasNoOp: false, ledgerRowId: "x", status: "test",
                                     qboInvoiceId: "TEST-9", qboDocNumber: "KFTxx" }),
    fireN1: async (args) => {
      n1Args = args;
      return {
        recipients: { to: ["kevin@kitchfix.com"], cc: [] },
        subject: "[TEST] ...", preheader: "", html: "",
        email: { result: "sent" },
        slack: { text: "", result: { sent: true } },
      };
    },
    fireN2: async () => { throw new Error("N2 must not fire"); },
    logger: { info: () => {}, warn: () => {} },
  };

  const result = await runFinalizeEffects(baseCtx(), deps);
  assert.equal(result.pushed, true, "the finalize still succeeds; the lookup is soft");
  assert.equal(n1Args.accountLabel, null,
    "accountLabel falls back to null on a miss, as before");
});
