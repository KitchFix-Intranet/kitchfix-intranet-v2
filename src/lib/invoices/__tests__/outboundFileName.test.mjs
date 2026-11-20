import { test } from "node:test";
import { strict as assert } from "node:assert";
import { outboundFileName, cleanPart } from "../outboundFileName.ts";

test("cleanPart: letters, digits, dash, underscore kept; everything else to _", () => {
  assert.equal(cleanPart("Acme Foods"), "Acme_Foods");
  assert.equal(cleanPart("Acme, Inc."), "Acme_Inc");
  assert.equal(cleanPart("A-B_C 1"), "A-B_C_1");
  assert.equal(cleanPart("spaces   collapse"), "spaces_collapse");
  assert.equal(cleanPart("_a_"), "a");
});

test("cleanPart: non-ASCII and slashes map to _; trailing _ trimmed", () => {
  assert.equal(cleanPart("Café"), "Caf");
  assert.equal(cleanPart("Café/Bar"), "Caf_Bar");
});

test("cleanPart: null / undefined / empty -> ''", () => {
  assert.equal(cleanPart(null), "");
  assert.equal(cleanPart(undefined), "");
  assert.equal(cleanPart(""), "");
});

test("outboundFileName: live mode, vendor + date + number", () => {
  assert.equal(
    outboundFileName("Acme Foods", "2026-11-02", "ABC-1", "live"),
    "Acme_Foods_20261102_ABC-1.pdf",
  );
});

test("outboundFileName: test mode prefixes TEST_", () => {
  assert.equal(
    outboundFileName("Acme Foods", "2026-11-02", "ABC-1", "test"),
    "TEST_Acme_Foods_20261102_ABC-1.pdf",
  );
});

test("outboundFileName: empty pieces fall back to placeholders", () => {
  assert.equal(outboundFileName("", "2026-11-02", "ABC-1", "live"), "vendor_20261102_ABC-1.pdf");
  assert.equal(outboundFileName("Acme", "", "ABC-1", "live"), "Acme_nodate_ABC-1.pdf");
  assert.equal(outboundFileName("Acme", "2026-11-02", "", "live"), "Acme_20261102_nonumber.pdf");
});

test("outboundFileName: bad date shape becomes 'nodate'", () => {
  assert.equal(outboundFileName("Acme", "11/02/2026", "X", "live"), "Acme_nodate_X.pdf");
});

test("outboundFileName: odd characters collapse", () => {
  assert.equal(
    outboundFileName("Acme / Co. (STL)", "2026-11-02", "INV #5.6/A", "live"),
    "Acme_Co_STL_20261102_INV_5_6_A.pdf",
  );
});
