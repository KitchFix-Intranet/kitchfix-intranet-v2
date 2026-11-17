// canWriteForAccount: corp -> every site; salaried -> own account;
// nothing else writes. Directors are flagged corp so they inherit
// corp's grant (Kevin ruling 2026-11-17).

import test from "node:test";
import assert from "node:assert/strict";
import { canWriteForAccount } from "../../access/canWriteForAccount.ts";

function v(flags) {
  return {
    worker_id: "w", display_name: "V", role: null,
    is_corp: !!flags.corp,
    is_regional_director: !!flags.rd,
    is_salaried: !!flags.sal,
    region: flags.region ?? null,
    account_key: flags.account ?? "",
    previewOf: null,
  };
}

test("canWrite: corp writes for every site", () => {
  assert.equal(canWriteForAccount(v({ corp: true }), "ANY - XX").ok, true);
});

test("canWrite: a regional director (flagged corp) writes for every site", () => {
  const dir = v({ corp: true, rd: true, sal: true, region: "East", account: "CORP" });
  assert.equal(canWriteForAccount(dir, "ANY - XX").ok, true);
  assert.equal(canWriteForAccount(dir, "OTHER - YY").ok, true);
});

test("canWrite: salaried writes for their own account only", () => {
  const sal = v({ sal: true, account: "AAA - XX" });
  assert.equal(canWriteForAccount(sal, "AAA - XX").ok, true);
  const other = canWriteForAccount(sal, "OTHER - YY");
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.code, "NOT_AUTHORIZED");
});

test("canWrite: hourly (no flag) writes nothing", () => {
  const h = v({});
  const r = canWriteForAccount(h, "ANY - XX");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "NOT_AUTHORIZED");
});
