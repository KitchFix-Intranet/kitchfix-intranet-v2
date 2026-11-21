// T7 ruling 3 + item 5 proof: matchField is a pure function that
// returns which field the needle hit, so the list row can say
// "Has item number 12345" or "Has item: ..." when the ingredient's
// own name did not match. Precedence is name > parent > category >
// item name > item number > vendor. Empty needle returns { all }.
//
// Run: node --import tsx scripts/t7_match_field_proof.mjs

import { matchField } from "../src/components/ingredients/matchField.ts";

let pass = 0;
let fail = 0;
function ok(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}\n       got  ${g}\n       want ${w}`); }
}

function makeRow(overrides = {}) {
  return {
    id: "ing-1",
    name: "Olive oil",
    parent: "Pantry",
    category: "Dairy and eggs",
    baseUnit: "gal",
    resale: false,
    allergens: [],
    allergensReviewedAt: null,
    linkedCount: 2,
    usd12m: 100,
    avgPerBase: 1,
    minPerBase: 1,
    maxPerBase: 1,
    spreadRatio: 1,
    statsByLens: {
      blended: { avgPerBase: 1, minPerBase: 1, maxPerBase: 1, spreadRatio: 1, pricedCount: 2, linkedCount: 2, usd12m: 100, unpricedUsd: 0 },
      standard: { avgPerBase: 1, minPerBase: 1, maxPerBase: 1, spreadRatio: 1, pricedCount: 2, linkedCount: 2, usd12m: 100, unpricedUsd: 0 },
      premium: { avgPerBase: null, minPerBase: null, maxPerBase: null, spreadRatio: null, pricedCount: 0, linkedCount: 0, usd12m: 0, unpricedUsd: 0 },
    },
    baseUom: "GAL",
    flagged: false,
    flagReason: null,
    pricedCount: 2,
    unpricedUsd: 0,
    issues: [],
    suggestedBaseUnit: null,
    medianBeforeExclusion: null,
    linkedItems: [
      {
        id: "item-1",
        name: "Olive Oil, Extra Virgin, 3 L",
        vendor: "Chef's Warehouse",
        perBase: 1,
        perBaseUom: "GAL",
        statusKind: "in_blend",
        perBaseInIngUnit: 1,
        reach: ["GAL"],
        outlier: false,
        priceManualOverride: false,
        grade: null,
        usd12m: 60,
        eachMeasure: null,
        packQty: 6,
        packSize: 3,
        packUom: "L",
        caseWeightLb: null,
        itemNumber: "12345",
        lastSeen: "2026-11-01",
        catchWeight: false,
        packText: "6 x 3 L",
      },
      {
        id: "item-2",
        name: "Soybean Oil, 1 Gal",
        vendor: "Sysco",
        perBase: 1,
        perBaseUom: "GAL",
        statusKind: "in_blend",
        perBaseInIngUnit: 1,
        reach: ["GAL"],
        outlier: false,
        priceManualOverride: false,
        grade: null,
        usd12m: 40,
        eachMeasure: null,
        packQty: 6,
        packSize: 1,
        packUom: "GAL",
        caseWeightLb: null,
        itemNumber: "99999",
        lastSeen: "2026-10-15",
        catchWeight: false,
        packText: "6 x 1 GAL",
      },
    ],
    eachMeasureQty: null,
    eachMeasureUom: null,
    eachMeasureSource: null,
    measures: [],
    yieldPct: null,
    yieldSource: null,
    ...overrides,
  };
}

const row = makeRow();

ok("empty needle: all", matchField(row, ""), { kind: "all" });
ok("needle miss: none", matchField(row, "banana"), { kind: "none" });
ok("name match", matchField(row, "olive"), { kind: "hit", field: "name" });
ok("parent match (name does not contain needle)", matchField(row, "pantry"), { kind: "hit", field: "parent" });
ok(
  "category match (name + parent do not)",
  matchField(row, "dairy"),
  { kind: "hit", field: "category" },
);
ok(
  "item name match",
  matchField(row, "soybean"),
  { kind: "hit", field: "item", item: row.linkedItems[1] },
);
ok(
  "item number match (name/parent/category/item name miss)",
  matchField(row, "99999"),
  { kind: "hit", field: "itemNumber", item: row.linkedItems[1] },
);
ok(
  "vendor match (last in precedence)",
  matchField(row, "sysco"),
  { kind: "hit", field: "vendor", item: row.linkedItems[1] },
);

// Precedence: when the needle hits multiple fields, the earlier one wins.
const row2 = makeRow({ name: "Chef Oil", linkedItems: [{ ...row.linkedItems[0], name: "Chef Oil, Extra Virgin" }] });
ok(
  "precedence: name beats item name",
  matchField(row2, "chef"),
  { kind: "hit", field: "name" },
);

// A number in the ingredient name must beat an item number.
const row3 = makeRow({ name: "2% Milk" });
ok("precedence: ingredient name beats item number", matchField(row3, "2"), { kind: "hit", field: "name" });

// Case-insensitive matching.
ok("case-insensitive name", matchField(row, "OLIVE"), { kind: "hit", field: "name" });
ok("case-insensitive item number", matchField(row, "99999"), { kind: "hit", field: "itemNumber", item: row.linkedItems[1] });

console.log("");
console.log(`T7 match-field proof: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
