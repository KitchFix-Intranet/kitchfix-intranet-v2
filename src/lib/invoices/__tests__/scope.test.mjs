import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveInvoiceScope, sitesInScope, isManySites } from "../scope.ts";

// Made-up site list covering two regions.
const SITES = [
  { team_key: "AAA - FL", name: "Alpha FL",  region: "SE" },
  { team_key: "BBB - FL", name: "Bravo FL",  region: "SE" },
  { team_key: "CCC - AZ", name: "Charlie AZ", region: "SW" },
  { team_key: "DDD - TX", name: "Delta TX",  region: "SW" },
  { team_key: "EEE - MO", name: "Echo MO",   region: "MW" },
];

function v(partial) {
  return Object.assign({
    is_owner: false,
    is_invoice_admin: false,
    is_regional_director: false,
    is_corp: false,
    is_salaried: false,
    region: null,
    account_key: null,
  }, partial);
}

test("1. owner not previewing: every site", () => {
  const scope = resolveInvoiceScope(v({ is_owner: true }), SITES);
  assert.equal(scope.kind, "owner");
  assert.deepEqual(scope.accountKeys.sort(), ["AAA - FL","BBB - FL","CCC - AZ","DDD - TX","EEE - MO"]);
  assert.equal(scope.words.fix, "Needs a fix");
});

test("2. invoice reviewer (office): every site, office words", () => {
  const scope = resolveInvoiceScope(v({ is_invoice_admin: true }), SITES);
  assert.equal(scope.kind, "office");
  assert.equal(scope.accountKeys.length, 5);
  assert.equal(scope.words.fix, "Sent back");
  assert.equal(scope.words.fixPlural(1), "1 invoice sent back");
  assert.equal(scope.words.fixPlural(3), "3 invoices sent back");
});

test("3. regional director: sites in their region only", () => {
  const scope = resolveInvoiceScope(
    v({ is_regional_director: true, is_corp: true, region: "SE" }),
    SITES,
  );
  assert.equal(scope.kind, "regional_director");
  assert.deepEqual(scope.accountKeys.sort(), ["AAA - FL","BBB - FL"]);
  assert.equal(scope.words.fix, "Needs a fix");
});

test("3a. RD-also-corp: still filters to their region, NOT every site", () => {
  const scope = resolveInvoiceScope(
    v({ is_regional_director: true, is_corp: true, region: "SW" }),
    SITES,
  );
  assert.equal(scope.kind, "regional_director");
  assert.deepEqual(scope.accountKeys.sort(), ["CCC - AZ","DDD - TX"]);
});

test("3b. RD with no region: empty list", () => {
  const scope = resolveInvoiceScope(
    v({ is_regional_director: true, is_corp: true, region: null }),
    SITES,
  );
  assert.equal(scope.kind, "regional_director");
  assert.deepEqual(scope.accountKeys, []);
});

test("4. salaried tied to a site: that one site", () => {
  const scope = resolveInvoiceScope(
    v({ is_salaried: true, account_key: "BBB - FL" }),
    SITES,
  );
  assert.equal(scope.kind, "site_manager");
  assert.deepEqual(scope.accountKeys, ["BBB - FL"]);
});

test("4a. salaried, account_key not in scope list: falls through to rule 5 (none)", () => {
  // "account_key is a site" means the key appears in the in-scope
  // list. Someone salaried on CORP, or on a key that no longer
  // exists, is not rule 4; they land in rule 5.
  const scope = resolveInvoiceScope(
    v({ is_salaried: true, account_key: "ZZZ - XX" }),
    SITES,
  );
  assert.equal(scope.kind, "none");
  assert.deepEqual(scope.accountKeys, []);
});

test("4b. salaried but account_key null: falls through to rule 5 (none)", () => {
  // Rule 4 requires 'salaried AND account_key is a site'. Without
  // an account_key the person is not tied to any site, so they
  // land in rule 5 (anyone else) and the surface shows the
  // no-access state, not a 404.
  const scope = resolveInvoiceScope(
    v({ is_salaried: true, account_key: null }),
    SITES,
  );
  assert.equal(scope.kind, "none");
  assert.deepEqual(scope.accountKeys, []);
});

test("5. hourly (nothing): no sites, kind 'none'", () => {
  const scope = resolveInvoiceScope(v({}), SITES);
  assert.equal(scope.kind, "none");
  assert.deepEqual(scope.accountKeys, []);
});

test("5a. corporate without invoice-admin or RD: no sites either", () => {
  // Someone in Corp, not an invoice reviewer, not an RD, not salaried
  // at a site. Rule 5 catches them.
  const scope = resolveInvoiceScope(
    v({ is_corp: true, region: null }),
    SITES,
  );
  assert.equal(scope.kind, "none");
  assert.deepEqual(scope.accountKeys, []);
});

test("reviewer-also-salaried-at-a-site: office path wins; sees every site", () => {
  const scope = resolveInvoiceScope(
    v({ is_invoice_admin: true, is_salaried: true, account_key: "AAA - FL" }),
    SITES,
  );
  assert.equal(scope.kind, "office");
  assert.equal(scope.accountKeys.length, 5);
});

test("owner also having the invoice-admin flag: office words win", () => {
  // 2026-11-17 Chat-Claude ruling. The owner-not-previewing path
  // only decides access ("every site"). Office words come from the
  // is_invoice_admin flag. An owner who is also a reviewer (Kevin
  // today) must see "Sent back", not "Needs a fix".
  const scope = resolveInvoiceScope(
    v({ is_owner: true, is_invoice_admin: true }),
    SITES,
  );
  assert.equal(scope.kind, "office");
  assert.equal(scope.accountKeys.length, 5);
  assert.equal(scope.words.fix, "Sent back");
  assert.equal(scope.words.fixPlural(1), "1 invoice sent back");
});

test("owner WITHOUT the invoice-admin flag: owner words, every site", () => {
  const scope = resolveInvoiceScope(
    v({ is_owner: true, is_invoice_admin: false }),
    SITES,
  );
  assert.equal(scope.kind, "owner");
  assert.equal(scope.accountKeys.length, 5);
  assert.equal(scope.words.fix, "Needs a fix");
});

test("sitesInScope: preserves input order of sites, keeps only in-scope keys", () => {
  const scope = resolveInvoiceScope(
    v({ is_regional_director: true, is_corp: true, region: "SE" }),
    SITES,
  );
  const nav = sitesInScope(scope, SITES);
  assert.deepEqual(nav.map((s) => s.accountKey), ["AAA - FL","BBB - FL"]);
  assert.equal(nav[0].slug, "aaa-fl");
});

test("isManySites: >1 account", () => {
  const owner = resolveInvoiceScope(v({ is_owner: true }), SITES);
  const site = resolveInvoiceScope(v({ is_salaried: true, account_key: "BBB - FL" }), SITES);
  const nobody = resolveInvoiceScope(v({}), SITES);
  assert.equal(isManySites(owner), true);
  assert.equal(isManySites(site), false);
  assert.equal(isManySites(nobody), false);
});
