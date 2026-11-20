// T6 ruling 1 proof. Two independent checks:
//
// Part A (client decision): for each row of the memo's save table,
// the editor's save decision calls the right API route(s) with the
// right body. The proof imports the REAL decidePackSave helper the
// editor uses (src/components/ingredients/panel/packHelpers.tsx) -
// in T6 round 2 item 8 the proof moved off a "pure mirror" copy to
// the real function, so a proof that passes guarantees the editor
// is right.
//
// Part B (library composition): setVendorItemPriceOverride NESTS the
// price inside a pre-existing hand-set pack override instead of
// replacing it. This is what makes "pack then price" compose
// without a route change. The proof seeds a vendor-item with a
// manual pack_override, calls the real setVendorItemPriceOverride
// against a stand-in store, and verifies the stored pack_override
// now holds BOTH the pack fields AND a nested price leaf.
//
// Run: node --import tsx scripts/t6_pack_save_proof.mjs

import { randomUUID } from "node:crypto";
import { setVendorItemPriceOverride } from "../src/lib/reviewWrites.ts";
import { decidePackSave } from "../src/components/ingredients/panel/packHelpers.tsx";

let pass = 0;
let fail = 0;
function ok(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`ok   ${label} (got ${g}, want ${w})`);
  } else {
    fail++;
    console.log(`FAIL ${label}\n       got  ${g}\n       want ${w}`);
  }
}

// ======================================================================
// Part A: client decision table.
// ======================================================================

// T6 round 2 item 8: the proof imports decidePackSave from the
// SAME module the editor uses, so the proof cannot pass when the
// editor is wrong. decidePackSave takes a flat state object and
// returns the sequence of POSTs the editor will send.
function decideSaveSequence(args) {
  return decidePackSave({
    itemId: args.item.id,
    catchWeight: args.catchWeight,
    catchWeightChanged: args.catchWeightChanged,
    packPristine: args.packPristine,
    qty: args.qty,
    size: args.size,
    uom: args.uom,
    perLb: args.perLb,
    billedUnit: args.billedUnit,
    note: args.note,
    caseFieldVal: args.caseFieldVal,
    defaultCaseVal: args.defaultCaseVal,
    caseFieldSrcLabel: args.caseFieldSrcLabel,
  });
}

const item = { id: "item-1" };

// Case 1: pack-only, no price change. Pack dirty, price pristine.
{
  const seq = decideSaveSequence({
    item,
    catchWeight: false,
    catchWeightChanged: false,
    packPristine: false,
    qty: 6,
    size: 1,
    uom: "GAL",
    perLb: 0,
    billedUnit: "case",
    note: "",
    caseFieldVal: 298.75,
    defaultCaseVal: 298.75,
    caseFieldSrcLabel: "billed",
  });
  ok("case 1: pack only, one POST", seq.length, 1);
  ok("case 1: pack only, route", seq[0]?.route, "/api/review/set-pack-override");
  ok("case 1: pack only, body", seq[0]?.body, {
    itemId: "item-1",
    catchWeight: false,
    qty: 6,
    size: 1,
    uom: "GAL",
    billedUnit: "case",
    note: null,
  });
}

// Case 2: price only, set by a shortcut (catalog). Pack pristine,
// price moved from 298.75 (billed default) to 310.00 (catalog shortcut).
{
  const seq = decideSaveSequence({
    item,
    catchWeight: false,
    catchWeightChanged: false,
    packPristine: true,
    qty: 6,
    size: 1,
    uom: "GAL",
    perLb: 0,
    billedUnit: "case",
    note: "",
    caseFieldVal: 310.0,
    defaultCaseVal: 298.75,
    caseFieldSrcLabel: "catalog",
  });
  ok("case 2: price shortcut, one POST", seq.length, 1);
  ok("case 2: price shortcut, route", seq[0]?.route, "/api/review/set-price-override");
  ok("case 2: price shortcut, reason mentions source", /Costed from catalog case price \$310\.00/.test(seq[0]?.body?.reason ?? ""), true);
  ok("case 2: price shortcut, perBase", Math.round((seq[0]?.body?.perBase ?? 0) * 1e6) / 1e6, Math.round((310 / (6 * 1 * 128)) * 1e6) / 1e6);
  ok("case 2: price shortcut, baseUom", seq[0]?.body?.baseUom, "FLOZ");
}

// Case 2b: price shortcut with a user note. The note is appended to
// the auto-reason.
{
  const seq = decideSaveSequence({
    item,
    catchWeight: false,
    catchWeightChanged: false,
    packPristine: true,
    qty: 6,
    size: 1,
    uom: "GAL",
    perLb: 0,
    billedUnit: "case",
    note: "vendor confirmed this week",
    caseFieldVal: 310.0,
    defaultCaseVal: 298.75,
    caseFieldSrcLabel: "catalog",
  });
  ok("case 2b: note appended to auto-reason", /Costed from catalog case price \$310\.00.*vendor confirmed this week/.test(seq[0]?.body?.reason ?? ""), true);
}

// Case 3: price typed, matching no file. The reason is the note, or
// "Price typed in the pack editor" when empty.
{
  const seq = decideSaveSequence({
    item,
    catchWeight: false,
    catchWeightChanged: false,
    packPristine: true,
    qty: 6,
    size: 1,
    uom: "GAL",
    perLb: 0,
    billedUnit: "case",
    note: "",
    caseFieldVal: 272.5,
    defaultCaseVal: 298.75,
    caseFieldSrcLabel: "typed",
  });
  ok("case 3: price typed empty note, one POST", seq.length, 1);
  ok("case 3: price typed empty note, reason", seq[0]?.body?.reason, "Price typed in the pack editor");
}
{
  const seq = decideSaveSequence({
    item,
    catchWeight: false,
    catchWeightChanged: false,
    packPristine: true,
    qty: 6,
    size: 1,
    uom: "GAL",
    perLb: 0,
    billedUnit: "case",
    note: "pricing error on invoice",
    caseFieldVal: 272.5,
    defaultCaseVal: 298.75,
    caseFieldSrcLabel: "typed",
  });
  ok("case 3b: price typed with note, reason is the note", seq[0]?.body?.reason, "pricing error on invoice");
}

// Case 4: pack and price both. Two POSTs; pack first, then price.
{
  const seq = decideSaveSequence({
    item,
    catchWeight: false,
    catchWeightChanged: false,
    packPristine: false,
    qty: 4,
    size: 1,
    uom: "GAL",
    perLb: 0,
    billedUnit: "case",
    note: "",
    caseFieldVal: 220.0,
    defaultCaseVal: 298.75,
    caseFieldSrcLabel: "typed",
  });
  ok("case 4: pack+price, two POSTs", seq.length, 2);
  ok("case 4: pack+price, first route", seq[0]?.route, "/api/review/set-pack-override");
  ok("case 4: pack+price, second route", seq[1]?.route, "/api/review/set-price-override");
  ok("case 4: pack+price, pack body", seq[0]?.body, {
    itemId: "item-1",
    catchWeight: false,
    qty: 4,
    size: 1,
    uom: "GAL",
    billedUnit: "case",
    note: null,
  });
  ok("case 4: pack+price, price perBase uses new pack", Math.round((seq[1]?.body?.perBase ?? 0) * 1e6) / 1e6, Math.round((220 / (4 * 1 * 128)) * 1e6) / 1e6);
}

// Case 5: catch weight. One POST; no case-price branching.
{
  const seq = decideSaveSequence({
    item,
    catchWeight: true,
    catchWeightChanged: false,
    packPristine: true,
    qty: 0,
    size: 0,
    uom: "",
    perLb: 5.29,
    billedUnit: "lb",
    note: "",
    caseFieldVal: null,
    defaultCaseVal: null,
    caseFieldSrcLabel: null,
  });
  ok("case 5: catch weight, one POST", seq.length, 1);
  ok("case 5: catch weight, route", seq[0]?.route, "/api/review/set-pack-override");
  ok("case 5: catch weight, body", seq[0]?.body, {
    itemId: "item-1",
    catchWeight: true,
    perLb: 5.29,
    billedUnit: "lb",
    note: null,
  });
}

// Case 6 (NEW in T6 - memo marks this as new): price typed, matching
// no file. The old editor would drop the typed value and recompute
// from the stored source. The new editor sends the typed price via
// set-price-override.
{
  const seq = decideSaveSequence({
    item,
    catchWeight: false,
    catchWeightChanged: false,
    packPristine: true,
    qty: 6,
    size: 1,
    uom: "GAL",
    perLb: 0,
    billedUnit: "case",
    note: "",
    caseFieldVal: 275.0, // doesn't match catalog (298.75) or billed (310)
    defaultCaseVal: 298.75,
    caseFieldSrcLabel: "typed",
  });
  ok("case 6 (new): typed price sends set-price-override", seq[0]?.route, "/api/review/set-price-override");
  ok("case 6 (new): perBase from typed case price", Math.round((seq[0]?.body?.perBase ?? 0) * 1e6) / 1e6, Math.round((275 / (6 * 1 * 128)) * 1e6) / 1e6);
}

// ======================================================================
// Part B: library composition (stand-in supabase).
// ======================================================================
//
// setVendorItemPriceOverride nests the price inside the existing
// hand-set pack override when isPackManualOverride(prevPo) returns
// true. The two keys that matter: the stored pack_override still
// carries qty/size/uom AFTER the price override lands.

function makeStandinClient(db) {
  // Minimal subset: .from(table).select(cols).eq().maybeSingle(),
  // .from(table).select().eq().eq().neq() (twins read),
  // .from(table).update(patch).eq(), .from(table).insert(row).
  function from(table) {
    const store = db[table];
    if (!store) throw new Error(`stand-in: unknown table ${table}`);
    function queryBuilder(filters = []) {
      return {
        eq(col, val) {
          return queryBuilder([...filters, { op: "eq", col, val }]);
        },
        neq(col, val) {
          return queryBuilder([...filters, { op: "neq", col, val }]);
        },
        maybeSingle() {
          const row = [...store.values()].find((r) => filters.every((f) => matchFilter(r, f)));
          return Promise.resolve({ data: row ?? null, error: null });
        },
        then(resolve) {
          const rows = [...store.values()].filter((r) => filters.every((f) => matchFilter(r, f)));
          resolve({ data: rows, error: null });
        },
      };
    }
    return {
      select() {
        return queryBuilder();
      },
      update(patch) {
        return {
          eq(col, val) {
            return {
              async eq(col2, val2) {
                // Two-eq chain: update where col=val and col2=val2.
                for (const [k, r] of store.entries()) {
                  if (r[col] === val && r[col2] === val2) {
                    store.set(k, { ...r, ...patch });
                  }
                }
                return { data: null, error: null };
              },
              async select() {
                // Fallthrough: .update().eq().select() shape reads the
                // row AFTER applying the patch. Not every path uses it;
                // keep it minimal.
                const updated = [];
                for (const [k, r] of store.entries()) {
                  if (r[col] === val) {
                    const patched = { ...r, ...patch };
                    store.set(k, patched);
                    updated.push(patched);
                  }
                }
                return { data: updated, error: null };
              },
              then(resolve) {
                for (const [k, r] of store.entries()) {
                  if (r[col] === val) store.set(k, { ...r, ...patch });
                }
                resolve({ data: null, error: null });
              },
            };
          },
        };
      },
      insert(row) {
        const id = row.id ?? randomUUID();
        const stored = { ...row, id, at: row.at ?? new Date().toISOString() };
        store.set(id, stored);
        return {
          select() {
            return {
              async maybeSingle() {
                return { data: stored, error: null };
              },
            };
          },
          then(resolve) {
            resolve({ data: null, error: null });
          },
        };
      },
    };
  }
  return { from };
}

function matchFilter(row, f) {
  if (f.op === "eq") return (row[f.col] ?? null) === f.val;
  if (f.op === "neq") return (row[f.col] ?? null) !== f.val;
  return false;
}

async function proveComposition() {
  const db = {
    pr_vendor_items: new Map(),
    pr_events: new Map(),
    // the price function also reads these tables in some paths;
    // seeding empty Maps is enough because the composition logic
    // only reads pr_vendor_items.pack_override.
    pr_ingredient_price_history: new Map(),
  };
  // Seed an item with a hand-set pack override (qty/size/uom), no
  // prior price leaf.
  const itemId = randomUUID();
  const packOverride = {
    catch_weight: false,
    qty: 6,
    size: 1,
    uom: "GAL",
    note: "set by hand",
    by: "test",
    at: "2026-11-20T00:00:00.000Z",
  };
  db.pr_vendor_items.set(itemId, {
    id: itemId,
    vendor_id: "v1",
    item_number_norm: "n1",
    price_estimate: { per_base: 2.33, base_uom: "FLOZ", case_price: 298.75, case_price_source: "billed", pack_source: "override", confidence: "high" },
    pack_override: packOverride,
    status: "active",
  });

  const client = makeStandinClient(db);
  const res = await setVendorItemPriceOverride(client, {
    itemId,
    perBase: 0.025,
    baseUom: "FLOZ",
    reason: "Price typed in the pack editor",
    actorEmail: "test",
  });

  const after = db.pr_vendor_items.get(itemId);
  ok("Part B: ok=true", res.ok, true);
  ok("Part B: pack qty preserved", after?.pack_override?.qty, 6);
  ok("Part B: pack size preserved", after?.pack_override?.size, 1);
  ok("Part B: pack uom preserved", after?.pack_override?.uom, "GAL");
  ok("Part B: price leaf nested", after?.pack_override?.price?.per_base, 0.025);
  ok("Part B: price baseUom nested", after?.pack_override?.price?.base_uom, "FLOZ");
  ok("Part B: price note nested", after?.pack_override?.price?.note, "Price typed in the pack editor");
  ok("Part B: no price_only shim (pack is still real)", after?.pack_override?.price_only, undefined);
  ok(
    "Part B: price_estimate replaced",
    after?.price_estimate?.per_base,
    0.025,
  );
  ok(
    "Part B: price_estimate case_price_source",
    after?.price_estimate?.case_price_source,
    "override",
  );
}

await proveComposition();

console.log("");
console.log(`T6 pack-save proof: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
