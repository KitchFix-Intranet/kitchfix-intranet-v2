// sc-64: who may submit for a site.

import test from "node:test";
import assert from "node:assert/strict";
import { canSubmitForAccount } from "../../submit/canSubmit.ts";
import { makeSupaMock } from "./_supa-mock-submit.mjs";

function seed(people, account) {
  return { people, accounts: account ? [account] : [] };
}

test("canSubmit: corporate ACTIVE row returns via=corp", async () => {
  const supa = makeSupaMock({
    tables: seed(
      [{ work_email: "kevin@kitchfix.com", status: "ACTIVE", is_corp: true, account_key: null,
         is_salaried: null, is_regional_director: null, region: null }],
      { team_key: "TXR - AZ", region: "West", timezone: "America/Phoenix" },
    ),
  });
  const got = await canSubmitForAccount("kevin@kitchfix.com", "TXR - AZ", supa);
  assert.deepEqual(got, { allowed: true, via: "corp" });
});

test("canSubmit: regional director matching region returns via=regional_director", async () => {
  const supa = makeSupaMock({
    tables: seed(
      [{ work_email: "rd@kitchfix.com", status: "ACTIVE", is_corp: null,
         is_regional_director: true, region: "West", account_key: null, is_salaried: null }],
      { team_key: "TXR - AZ", region: "West", timezone: "America/Phoenix" },
    ),
  });
  const got = await canSubmitForAccount("rd@kitchfix.com", "TXR - AZ", supa);
  assert.deepEqual(got, { allowed: true, via: "regional_director" });
});

test("canSubmit: regional director in the other region is refused", async () => {
  const supa = makeSupaMock({
    tables: seed(
      [{ work_email: "rd@kitchfix.com", status: "ACTIVE", is_corp: null,
         is_regional_director: true, region: "East", account_key: null, is_salaried: null }],
      { team_key: "TXR - AZ", region: "West", timezone: "America/Phoenix" },
    ),
  });
  const got = await canSubmitForAccount("rd@kitchfix.com", "TXR - AZ", supa);
  assert.deepEqual(got, { allowed: false, via: null });
});

test("canSubmit: salaried at the account returns via=site", async () => {
  const supa = makeSupaMock({
    tables: seed(
      [{ work_email: "leader@kitchfix.com", status: "ACTIVE", is_corp: null,
         is_salaried: true, account_key: "TXR - AZ", is_regional_director: null, region: null }],
      { team_key: "TXR - AZ", region: "West", timezone: "America/Phoenix" },
    ),
  });
  const got = await canSubmitForAccount("leader@kitchfix.com", "TXR - AZ", supa);
  assert.deepEqual(got, { allowed: true, via: "site" });
});

test("canSubmit: a TERMINATED row does not count", async () => {
  const supa = makeSupaMock({
    tables: seed(
      [{ work_email: "ex@kitchfix.com", status: "TERMINATED", is_corp: true,
         account_key: null, is_salaried: null, is_regional_director: null, region: null }],
      { team_key: "TXR - AZ", region: "West", timezone: "America/Phoenix" },
    ),
  });
  const got = await canSubmitForAccount("ex@kitchfix.com", "TXR - AZ", supa);
  assert.deepEqual(got, { allowed: false, via: null });
});

test("canSubmit: an ACTIVE + TERMINATED pair for one address counts as one yes", async () => {
  const supa = makeSupaMock({
    tables: seed(
      [
        { work_email: "veteran@kitchfix.com", status: "TERMINATED", is_corp: true,
          account_key: null, is_salaried: null, is_regional_director: null, region: null },
        { work_email: "veteran@kitchfix.com", status: "ACTIVE", is_corp: true,
          account_key: null, is_salaried: null, is_regional_director: null, region: null },
      ],
      { team_key: "TXR - AZ", region: "West", timezone: "America/Phoenix" },
    ),
  });
  const got = await canSubmitForAccount("veteran@kitchfix.com", "TXR - AZ", supa);
  assert.deepEqual(got, { allowed: true, via: "corp" });
});

test("canSubmit: no rows at all is refused", async () => {
  const supa = makeSupaMock({
    tables: seed([], { team_key: "TXR - AZ", region: "West", timezone: null }),
  });
  const got = await canSubmitForAccount("stranger@kitchfix.com", "TXR - AZ", supa);
  assert.deepEqual(got, { allowed: false, via: null });
});

test("canSubmit: a failed read returns false and does not throw", async () => {
  const throwing = { from() { throw new Error("DB down"); } };
  const got = await canSubmitForAccount("anyone@kitchfix.com", "TXR - AZ", throwing);
  assert.deepEqual(got, { allowed: false, via: null });
});
