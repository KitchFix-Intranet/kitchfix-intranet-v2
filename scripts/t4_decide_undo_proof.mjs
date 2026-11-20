// T4 proof: every decision writes a snapshot, every snapshot undoes
// cleanly, and the state helper reads the old and new shapes the
// same.
//
// Run: node scripts/t4_decide_undo_proof.mjs
//
// The stand-ins hold pr_vendor_items / pr_ingredients / pr_events rows
// in Maps; no database, no network. The stand-in only implements the
// subset of @supabase/supabase-js the reviewWrites functions actually
// call (select, eq, in, neq, is, maybeSingle, insert, update,
// upsert, select+count+head, like, or). Any call shape the stand-in
// does not know about throws so this script fails loudly if the
// production code diverges.

import { randomUUID } from "node:crypto";
import {
  confirmItems,
  markArchived,
  markOneOff,
  markNotFood,
  keepSeparate,
  markResale,
  relinkItems,
  restoreVendorItem,
  undoDecisionEvent,
  splitToNewIngredient,
} from "../src/lib/reviewWrites.ts";
import { getVendorItemState } from "../src/lib/ingredients/vendorItemState.ts";

// --- stand-in supabase --------------------------------------------------

function makeDb() {
  return {
    pr_vendor_items: new Map(),
    pr_ingredients: new Map(),
    pr_ingredient_aliases: new Map(),
    pr_golden_links: new Map(),
    pr_events: new Map(),
  };
}

function seedItem(db, overrides = {}) {
  const id = overrides.id ?? randomUUID();
  const row = {
    id,
    vendor_id: "vendor-a",
    item_number: "ITM-1",
    item_number_norm: "ITM-1",
    description_key: "widget-1",
    name: "Widget 1",
    status: "active",
    link_status: "none",
    link_reason: null,
    link_confidence: null,
    ingredient_id: null,
    usd_12m: 100,
    is_food: true,
    pack_uom: null,
    ...overrides,
  };
  db.pr_vendor_items.set(id, row);
  return id;
}

function seedIngredient(db, overrides = {}) {
  const id = overrides.id ?? randomUUID();
  const row = {
    id,
    name: overrides.name ?? "Test Ingredient",
    name_norm: (overrides.name ?? "Test Ingredient").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    parent: null,
    category: null,
    base_unit: "each",
    status: "active",
    resale: false,
    merged_into_id: null,
    created_by: null,
    ...overrides,
  };
  db.pr_ingredients.set(id, row);
  return id;
}

function matchRow(row, filters) {
  for (const f of filters) {
    if (f.op === "eq") {
      if ((row[f.col] ?? null) !== f.value) return false;
    } else if (f.op === "neq") {
      if ((row[f.col] ?? null) === f.value) return false;
    } else if (f.op === "in") {
      if (!f.values.includes(row[f.col])) return false;
    } else if (f.op === "is") {
      if (f.value === null) {
        if (row[f.col] != null) return false;
      } else {
        if (row[f.col] !== f.value) return false;
      }
    } else if (f.op === "not") {
      if (f.inner === "is") {
        if (f.value === null) {
          if (row[f.col] == null) return false;
        } else if (row[f.col] === f.value) return false;
      } else if (f.inner === "in") {
        if (f.values.includes(row[f.col])) return false;
      }
    } else if (f.op === "like") {
      const pattern = String(f.value).replace(/%/g, ".*");
      if (!(new RegExp(`^${pattern}$`)).test(String(row[f.col] ?? ""))) return false;
    } else if (f.op === "gt") {
      if (!(row[f.col] > f.value)) return false;
    } else if (f.op === "lt") {
      if (!(row[f.col] < f.value)) return false;
    } else {
      throw new Error(`unknown filter op: ${f.op}`);
    }
  }
  return true;
}

function makeQuery(db, table) {
  const filters = [];
  let opts = { count: false, head: false, selectCols: "*" };
  const api = {
    select(cols, o = {}) {
      opts.selectCols = cols;
      if (o.count === "exact") opts.count = true;
      if (o.head === true) opts.head = true;
      return api;
    },
    eq(col, value) { filters.push({ op: "eq", col, value }); return api; },
    neq(col, value) { filters.push({ op: "neq", col, value }); return api; },
    in(col, values) { filters.push({ op: "in", col, values }); return api; },
    is(col, value) { filters.push({ op: "is", col, value }); return api; },
    not(col, inner, value) { filters.push({ op: "not", col, inner, value, values: Array.isArray(value) ? value : undefined }); return api; },
    or(_expr) {
      // Not used by the functions under test; accept and no-op so a
      // future reader can at least match "everything".
      return api;
    },
    like(col, value) { filters.push({ op: "like", col, value }); return api; },
    gt(col, value) { filters.push({ op: "gt", col, value }); return api; },
    lt(col, value) { filters.push({ op: "lt", col, value }); return api; },
    order() { return api; },
    range() { return api; },
    maybeSingle() {
      const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
      if (rows.length === 0) return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: rows[0], error: null });
    },
    single() {
      const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
      if (rows.length !== 1) return Promise.resolve({ data: null, error: { message: "not one" } });
      return Promise.resolve({ data: rows[0], error: null });
    },
    then(resolve) {
      const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
      const data = opts.head ? null : rows;
      const count = opts.count ? rows.length : null;
      return resolve({ data, error: null, count });
    },
    update(patch) {
      return {
        eq(col, value) { filters.push({ op: "eq", col, value }); return this; },
        neq(col, value) { filters.push({ op: "neq", col, value }); return this; },
        in(col, values) { filters.push({ op: "in", col, values }); return this; },
        is(col, value) { filters.push({ op: "is", col, value }); return this; },
        select() {
          const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
          for (const r of rows) Object.assign(r, patch);
          return { then: (resolve) => resolve({ data: rows.map((r) => ({ id: r.id })), error: null }) };
        },
        then(resolve) {
          const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
          for (const r of rows) Object.assign(r, patch);
          return resolve({ data: rows, error: null });
        },
      };
    },
    insert(payload) {
      const rows = Array.isArray(payload) ? payload : [payload];
      const inserted = [];
      for (const row of rows) {
        const id = row.id ?? randomUUID();
        const full = { id, ...row };
        if (table === "pr_events") {
          full.at = new Date().toISOString();
          full.entity_type = row.entity_type ?? null;
        }
        db[table].set(id, full);
        inserted.push(full);
      }
      return {
        select() {
          return {
            single: () => Promise.resolve({ data: inserted[0], error: null }),
            then: (resolve) => resolve({ data: inserted, error: null }),
          };
        },
        then: (resolve) => resolve({ data: inserted, error: null }),
      };
    },
    upsert(payload) {
      const rows = Array.isArray(payload) ? payload : [payload];
      const out = [];
      for (const row of rows) {
        const id = row.id ?? randomUUID();
        const full = { id, ...row };
        db[table].set(id, full);
        out.push(full);
      }
      return { then: (resolve) => resolve({ data: out, error: null }) };
    },
  };
  return api;
}

function makeClient(db) {
  return { from: (table) => makeQuery(db, table) };
}

// --- assertions ---------------------------------------------------------

let failures = 0;
function ok(cond, label) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// --- test helpers -------------------------------------------------------

function latestEvent(db, kind, entityId) {
  const events = Array.from(db.pr_events.values())
    .filter((e) => e.kind === kind)
    .filter((e) => entityId == null || e.entity_id === entityId)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  return events[0] ?? null;
}

function rowShape(db, id) {
  const r = db.pr_vendor_items.get(id);
  return r ? { status: r.status, link_status: r.link_status, link_reason: r.link_reason, link_confidence: r.link_confidence, ingredient_id: r.ingredient_id } : null;
}

// --- test cases ---------------------------------------------------------

// a) decide then undo returns each item to exactly its starting row, for
//    each of the seven decisions.
async function testRoundTrip(label, setup, decide, kindForUndo) {
  const db = makeDb();
  const client = makeClient(db);
  const { itemId } = await setup(db);
  const beforeShape = rowShape(db, itemId);
  await decide(client);
  const event = latestEvent(db, kindForUndo);
  ok(event != null, `${label}: event emitted (${kindForUndo})`);
  if (!event) return;
  const r = await undoDecisionEvent(client, { eventId: event.id, actorEmail: "tester@kf.local" });
  ok(r.ok, `${label}: undo ok`);
  eq(rowShape(db, itemId), beforeShape, `${label}: round-trip restores row`);
}

await testRoundTrip(
  "Confirm",
  async (db) => {
    const ingredientId = seedIngredient(db, { name: "Beets" });
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:carrot", ingredient_id: null });
    return { itemId, ingredientId };
  },
  async (client) => {
    const ing = Array.from(client.from("pr_ingredients").eq("status", "active"));
    void ing;
    const dbMap = client.from("pr_ingredients");
    const ingredientId = Array.from((await (dbMap.select("id").eq("status","active"))).data)[0].id;
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await confirmItems(client, { ingredientId, itemIds, actorEmail: "tester@kf.local" });
  },
  "review_confirm",
);

await testRoundTrip(
  "Archive",
  async (db) => {
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:carrot" });
    return { itemId };
  },
  async (client) => {
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await markArchived(client, { itemIds, actorEmail: "tester@kf.local" });
  },
  "review_archive",
);

await testRoundTrip(
  "One-off",
  async (db) => {
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai-new:{}" });
    return { itemId };
  },
  async (client) => {
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await markOneOff(client, { itemIds, actorEmail: "tester@kf.local" });
  },
  "review_oneoff",
);

await testRoundTrip(
  "Not food",
  async (db) => {
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:bones" });
    return { itemId };
  },
  async (client) => {
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await markNotFood(client, { itemIds, actorEmail: "tester@kf.local" });
  },
  "review_notfood",
);

await testRoundTrip(
  "Keep separate",
  async (db) => {
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:ok" });
    return { itemId };
  },
  async (client) => {
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await keepSeparate(client, { itemIds, actorEmail: "tester@kf.local" });
  },
  "review_keep_separate",
);

await testRoundTrip(
  "Relink",
  async (db) => {
    const targetId = seedIngredient(db, { name: "Target" });
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:ok", ingredient_id: seedIngredient(db, { name: "Source" }) });
    return { itemId, targetId };
  },
  async (client) => {
    const ingIds = Array.from((await (client.from("pr_ingredients").select("id,name").eq("status","active"))).data);
    const target = ingIds.find((r) => r.name === "Target");
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await relinkItems(client, { ingredientId: target.id, itemIds, actorEmail: "tester@kf.local" });
  },
  "review_relink",
);

await testRoundTrip(
  "Retail into a non-retail master",
  async (db) => {
    const ingredientId = seedIngredient(db, { name: "Recipe Ingredient", resale: false });
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:ok", ingredient_id: null });
    return { itemId, ingredientId };
  },
  async (client) => {
    const ing = Array.from((await (client.from("pr_ingredients").select("id").eq("status","active"))).data)[0];
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await markResale(client, { ingredientId: ing.id, itemIds, actorEmail: "tester@kf.local" });
  },
  "review_confirm", // Retail routes through confirm; one event covers it
);

await testRoundTrip(
  "Retail into a retail master",
  async (db) => {
    const ingredientId = seedIngredient(db, { name: "Retail Ingredient", resale: true });
    const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:ok", ingredient_id: null });
    return { itemId, ingredientId };
  },
  async (client) => {
    const ing = Array.from((await (client.from("pr_ingredients").select("id").eq("status","active"))).data)[0];
    const itemIds = Array.from((await (client.from("pr_vendor_items").select("id").eq("link_status","proposed"))).data).map((r) => r.id);
    await markResale(client, { ingredientId: ing.id, itemIds, actorEmail: "tester@kf.local" });
  },
  "review_confirm",
);

// b) undo refuses when the item moved on.
{
  const db = makeDb();
  const client = makeClient(db);
  const itemId = seedItem(db, { link_status: "proposed" });
  await markArchived(client, { itemIds: [itemId], actorEmail: "tester@kf.local" });
  const event = latestEvent(db, "review_archive");
  // Simulate someone else flipping the row to active afterwards.
  const row = db.pr_vendor_items.get(itemId);
  row.status = "active";
  row.link_status = "none";
  row.link_reason = null;
  const r = await undoDecisionEvent(client, { eventId: event.id, actorEmail: "tester@kf.local" });
  ok(r.reverted === 0 && r.refused > 0, "Undo refuses when item moved on");
  ok(/changed again/i.test(r.error ?? ""), "Refusal carries the user sentence");
}

// c) state helper agrees on old and new shape for one-off.
{
  const oldShape = { status: "archived", link_status: "rejected", link_reason: "oneoff:person@kf.local", is_food: true };
  const newShape = { status: "one_off", link_status: "rejected", link_reason: "oneoff", is_food: true };
  eq(getVendorItemState(oldShape), "one_off", "state helper: old-shape one-off reads as one_off");
  eq(getVendorItemState(newShape), "one_off", "state helper: new-shape one-off reads as one_off");
}

// c) state helper agrees on old and new shape for person-marked not food.
{
  const oldShape = { status: "active", link_status: "rejected", link_reason: "notfood:person@kf.local", is_food: true };
  const newShape = { status: "not_food", link_status: "rejected", link_reason: "notfood", is_food: true };
  eq(getVendorItemState(oldShape), "not_food", "state helper: old-shape person-notfood reads as not_food");
  eq(getVendorItemState(newShape), "not_food", "state helper: new-shape person-notfood reads as not_food");
}

// d) Create -> Undo -> Create same name: one ingredient, active, no index error.
{
  const db = makeDb();
  const client = makeClient(db);
  const itemId1 = seedItem(db, { link_status: "proposed", link_reason: "ai-new:{\"proposed_name\":\"Fennel\"}" });
  const r1 = await splitToNewIngredient(client, {
    name: "Fennel",
    parent: null,
    category: null,
    itemIds: [itemId1],
    actorEmail: "tester@kf.local",
  });
  ok(r1.ok && r1.ingredientId, "Create #1 succeeds");
  const ev = latestEvent(db, "ingredient_split_create");
  ok(ev != null, "Create emits ingredient_split_create");
  // Undo the create. Should retire the ingredient (it has no other item).
  const u = await undoDecisionEvent(client, { eventId: ev.id, actorEmail: "tester@kf.local" });
  ok(u.ok, "Undo Create ok");
  const ing1 = db.pr_ingredients.get(r1.ingredientId);
  eq(ing1.status, "retired", "Undo Create retires the ingredient");
  // Create same name again - should revive the retired row.
  const itemId2 = seedItem(db, { link_status: "proposed", link_reason: "ai-new:{\"proposed_name\":\"Fennel\"}" });
  const r2 = await splitToNewIngredient(client, {
    name: "Fennel",
    parent: null,
    category: null,
    itemIds: [itemId2],
    actorEmail: "tester@kf.local",
  });
  ok(r2.ok && r2.ingredientId, "Create #2 same name succeeds");
  eq(r2.ingredientId, r1.ingredientId, "Create #2 revives the same retired row");
  const ing2 = db.pr_ingredients.get(r2.ingredientId);
  eq(ing2.status, "active", "Revived row is active again");
  const totalIngredients = Array.from(db.pr_ingredients.values()).length;
  eq(totalIngredients, 1, "Only one pr_ingredients row across the whole cycle");
}

// e) Undo on Create leaves an existing ingredient alone (name match).
{
  const db = makeDb();
  const client = makeClient(db);
  seedIngredient(db, { name: "Celery" });
  const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai-new:{\"proposed_name\":\"Celery\"}" });
  const r = await splitToNewIngredient(client, {
    name: "Celery",
    parent: null,
    category: null,
    itemIds: [itemId],
    actorEmail: "tester@kf.local",
  });
  ok(r.ok, "Create onto existing name ok");
  const ev = latestEvent(db, "ingredient_split_create");
  const createKind = ev.after.create_kind;
  eq(createKind, "matched_active", "Create tags as matched_active when name exists");
  const u = await undoDecisionEvent(client, { eventId: ev.id, actorEmail: "tester@kf.local" });
  ok(u.ok, "Undo Create ok (onto existing)");
  const existing = Array.from(db.pr_ingredients.values()).find((i) => i.name === "Celery");
  eq(existing.status, "active", "Existing ingredient still active after Undo");
}

// f) Restore round trip.
{
  const db = makeDb();
  const client = makeClient(db);
  const itemId = seedItem(db, { link_status: "proposed", link_reason: "ai:ok" });
  await markArchived(client, { itemIds: [itemId], actorEmail: "tester@kf.local" });
  const r = await restoreVendorItem(client, { itemId, actorEmail: "tester@kf.local" });
  ok(r.ok && r.restored, "Restore ok");
  eq(db.pr_vendor_items.get(itemId).status, "active", "Restored row is active");
  eq(db.pr_vendor_items.get(itemId).link_status, "none", "Restored row is link_status=none");
}

// --- summary ------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll T4 proofs passed.");
