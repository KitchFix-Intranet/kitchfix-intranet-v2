// Three-path visibility. RD first, then corp, then salaried.
// A regional director's row is also flagged corporate; the order
// decides their site set.

import test from "node:test";
import assert from "node:assert/strict";
import { visibleSites } from "../../calendar/accessList.ts";

const ACCS = [
  { team_key: "STL - FL", name: "St Louis Cardinals", region: "East", level: "PDC", timezone: null, active: true },
  { team_key: "TBJ - FL", name: "Toronto Blue Jays",  region: "East", level: "PDC", timezone: null, active: true },
  { team_key: "TBJ - NY", name: "Buffalo Bisons",     region: "East", level: "AAA", timezone: null, active: true },
  { team_key: "TBR - FL", name: "Tampa Bay Rays",     region: "East", level: "PDC", timezone: null, active: true },
  { team_key: "CIN - AZ", name: "Cincinnati Reds",    region: "West", level: "PDC", timezone: null, active: true },
  { team_key: "CIN - KY", name: "Louisville Bats",    region: "West", level: "AAA", timezone: null, active: true },
  { team_key: "TXR - AZ", name: "Texas Rangers",      region: "West", level: "PDC", timezone: null, active: true },
];

function v(flags) {
  return {
    worker_id: "w1",
    display_name: "V",
    role: null,
    is_corp: !!flags.corp,
    is_regional_director: !!flags.rd,
    is_salaried: !!flags.sal,
    region: flags.region ?? null,
    account_key: flags.account ?? "",
    previewOf: null,
  };
}

test("accessList: corporate sees every calendar account", () => {
  const seen = visibleSites(v({ corp: true }), ACCS);
  assert.equal(seen.length, 7);
});

test("accessList: regional director sees only their region, even when their row is also corporate", () => {
  // Both RDs on file carry is_corp = true. The order in the rule
  // (RD first) keeps them to their region.
  const seen = visibleSites(v({ corp: true, rd: true, region: "East" }), ACCS);
  assert.equal(seen.length, 4);
  for (const s of seen) assert.equal(s.region, "East");
});

test("accessList: regional director with a region nobody matches sees nothing", () => {
  const seen = visibleSites(v({ corp: true, rd: true, region: "Nowhere" }), ACCS);
  assert.equal(seen.length, 0);
});

test("accessList: salaried sees only their own account", () => {
  const seen = visibleSites(v({ sal: true, account: "TXR - AZ" }), ACCS);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].accountKey, "TXR - AZ");
});

test("accessList: hourly (no role flag) sees nothing", () => {
  const seen = visibleSites(v({}), ACCS);
  assert.equal(seen.length, 0);
});
