// T7 ruling 2 proof: Send back via undoConfirm, then re-confirm via
// confirmItems to the same ingredient, restores every person-visible
// field on the item. If anything a person reads on the Ingredients
// tab, the Review queue or the item panel would differ after the
// round trip, this proof fails and ruling 2 says Send back keeps the
// "What happens" ask and gets no Undo.
//
// The person-visible fields on the item + alias (ignoring timestamps
// / audit trails which are expected to change):
//   pr_vendor_items:
//     status, link_status, link_confidence, link_reason, ingredient_id,
//     grade, pack_override, each_measure_qty, each_measure_uom,
//     case_weight_lb, catch_weight, perBase / pack_qty / pack_size /
//     pack_uom (the pack shape the row renders)
//   pr_ingredient_aliases (the alias a person-made link leaves):
//     alias_text, alias_norm, kind, ingredient_id, revoked_at.
//
// Expected to change (not person-visible on the Ingredients tabs):
//   pr_golden_links.verified_at, pr_golden_links.verified_by.
//   New pr_events rows (review_undo, review_confirm).
//
// Run: node --import tsx scripts/t7_send_back_parity_proof.mjs

import { randomUUID } from "node:crypto";
import {
  confirmItems,
  undoConfirm,
} from "../src/lib/reviewWrites.ts";

// --- stand-in supabase (the subset undoConfirm + confirmItems touch) ---

let eventSeq = 0;
function nextEventAt() {
  eventSeq += 1;
  return new Date(Date.UTC(2026, 10, 20, 0, 0, 0, 0) + eventSeq).toISOString();
}

function makeDb() {
  return {
    pr_vendor_items: new Map(),
    pr_ingredients: new Map(),
    pr_ingredient_aliases: new Map(),
    pr_golden_links: new Map(),
    pr_events: new Map(),
  };
}

function readCol(row, col) {
  return row[col];
}
function matchRow(row, filters) {
  for (const f of filters) {
    const got = readCol(row, f.col);
    if (f.op === "eq") {
      if ((got ?? null) !== f.value) return false;
    } else if (f.op === "neq") {
      if ((got ?? null) === f.value) return false;
    } else if (f.op === "in") {
      if (!f.values.includes(got)) return false;
    } else if (f.op === "is") {
      if (f.value === null) { if (got != null) return false; }
      else { if (got !== f.value) return false; }
    } else if (f.op === "not") {
      if (f.inner === "is") {
        if (f.value === null) { if (got == null) return false; }
        else if (got === f.value) return false;
      }
    } else {
      throw new Error(`unknown filter op: ${f.op}`);
    }
  }
  return true;
}

function makeQuery(db, table) {
  const filters = [];
  let opts = { count: false, head: false };
  const api = {
    select(_cols, o = {}) {
      if (o.count === "exact") opts.count = true;
      if (o.head === true) opts.head = true;
      return api;
    },
    eq(col, value) { filters.push({ op: "eq", col, value }); return api; },
    neq(col, value) { filters.push({ op: "neq", col, value }); return api; },
    in(col, values) { filters.push({ op: "in", col, values }); return api; },
    is(col, value) { filters.push({ op: "is", col, value }); return api; },
    not(col, inner, value) { filters.push({ op: "not", col, inner, value }); return api; },
    order() { return api; },
    maybeSingle() {
      const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
      return Promise.resolve({ data: rows.length ? { ...rows[0] } : null, error: null });
    },
    single() {
      const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
      if (rows.length !== 1) return Promise.resolve({ data: null, error: { message: "not one" } });
      return Promise.resolve({ data: { ...rows[0] }, error: null });
    },
    then(resolve) {
      const rows = Array.from(db[table].values()).filter((r) => matchRow(r, filters));
      return resolve({
        data: opts.head ? null : rows.map((r) => ({ ...r })),
        error: null,
        count: opts.count ? rows.length : null,
      });
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
        if (table === "pr_events") full.at = nextEventAt();
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
    upsert(payload, opts = {}) {
      const rows = Array.isArray(payload) ? payload : [payload];
      const out = [];
      const onConflict = (opts.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const row of rows) {
        // Find an existing row matching the onConflict columns.
        let existing = null;
        if (onConflict.length) {
          for (const r of db[table].values()) {
            if (onConflict.every((c) => r[c] === row[c])) { existing = r; break; }
          }
        }
        if (existing) {
          Object.assign(existing, row);
          out.push(existing);
        } else {
          const id = row.id ?? randomUUID();
          const full = { id, ...row };
          db[table].set(id, full);
          out.push(full);
        }
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

let pass = 0;
let fail = 0;
function ok(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`ok   ${label}`); }
  else { fail++; console.log(`FAIL ${label}\n       got  ${g}\n       want ${w}`); }
}

// --- the test ------------------------------------------------------------

function personVisibleItem(db, itemId) {
  const r = db.pr_vendor_items.get(itemId);
  if (!r) return null;
  return {
    status: r.status ?? null,
    link_status: r.link_status ?? null,
    link_confidence: r.link_confidence ?? null,
    link_reason: r.link_reason ?? null,
    ingredient_id: r.ingredient_id ?? null,
    grade: r.grade ?? null,
    pack_override: r.pack_override ?? null,
    each_measure_qty: r.each_measure_qty ?? null,
    each_measure_uom: r.each_measure_uom ?? null,
    case_weight_lb: r.case_weight_lb ?? null,
    catch_weight: r.catch_weight ?? null,
    pack_qty: r.pack_qty ?? null,
    pack_size: r.pack_size ?? null,
    pack_uom: r.pack_uom ?? null,
    description_key: r.description_key ?? null,
    name: r.name ?? null,
  };
}

function personVisibleAlias(db, aliasNorm, ingredientId) {
  for (const a of db.pr_ingredient_aliases.values()) {
    if (a.alias_norm === aliasNorm && a.ingredient_id === ingredientId) {
      return {
        alias_text: a.alias_text ?? null,
        alias_norm: a.alias_norm ?? null,
        kind: a.kind ?? null,
        ingredient_id: a.ingredient_id ?? null,
        revoked_at: a.revoked_at == null ? null : "<stamped>",
      };
    }
  }
  return null;
}

async function run() {
  const db = makeDb();
  const client = makeClient(db);

  // Seed one ingredient + one confirmed item carrying every editable
  // field a person can see on the Ingredients tab or the item panel.
  const ingredientId = randomUUID();
  db.pr_ingredients.set(ingredientId, {
    id: ingredientId,
    name: "Olive oil",
    status: "active",
    resale: false,
  });
  const itemId = randomUUID();
  db.pr_vendor_items.set(itemId, {
    id: itemId,
    vendor_id: "vendor-a",
    name: "Olive Oil, Extra Virgin, 3 L",
    description_key: "olive oil extra virgin 3 l",
    status: "active",
    link_status: "confirmed",
    link_confidence: "high",
    link_reason: "confirmed",
    ingredient_id: ingredientId,
    grade: "premium",
    pack_override: { shape: { packQty: 6, packSize: 3, packUom: "L" }, reason: "vendor spec" },
    each_measure_qty: 3,
    each_measure_uom: "L",
    case_weight_lb: 59.5,
    catch_weight: false,
    pack_qty: 6,
    pack_size: 3,
    pack_uom: "L",
    usd_12m: 1200,
    is_food: true,
  });
  // The alias a person-made confirm left behind.
  db.pr_ingredient_aliases.set(randomUUID(), {
    id: randomUUID(),
    ingredient_id: ingredientId,
    alias_text: "Olive Oil, Extra Virgin, 3 L",
    alias_norm: "olive oil extra virgin 3 l",
    kind: "manual",
    revoked_at: null,
  });
  // The golden link.
  db.pr_golden_links.set(randomUUID(), {
    id: randomUUID(),
    vendor_item_id: itemId,
    ingredient_id: ingredientId,
    verified_by: "earlier@kf.local",
    verified_at: new Date(2026, 0, 1).toISOString(),
    revoked_at: null,
  });

  // --- snapshot BEFORE
  const beforeItem = personVisibleItem(db, itemId);
  const beforeAlias = personVisibleAlias(db, "olive oil extra virgin 3 l", ingredientId);

  // --- Send back
  const undoRes = await undoConfirm(client, { itemId, actorEmail: "tester@kf.local" });
  ok("send back ok", undoRes.ok, true);

  // Mid-state: just for the report
  const midItem = personVisibleItem(db, itemId);
  ok("send back: link_status flipped to proposed", midItem.link_status, "proposed");
  ok("send back: ingredient_id kept", midItem.ingredient_id, ingredientId);
  ok("send back: grade kept", midItem.grade, "premium");
  ok("send back: pack_override kept", midItem.pack_override, beforeItem.pack_override);
  ok("send back: each_measure kept", midItem.each_measure_qty, beforeItem.each_measure_qty);
  ok("send back: case_weight_lb kept", midItem.case_weight_lb, beforeItem.case_weight_lb);
  const midAlias = personVisibleAlias(db, "olive oil extra virgin 3 l", ingredientId);
  // Last confirmed item on this (desc_key, ingredient), so alias is soft-revoked.
  ok("send back: alias soft-revoked", midAlias.revoked_at, "<stamped>");

  // --- Re-confirm to the same ingredient (what Undo would do)
  const confirmRes = await confirmItems(client, {
    ingredientId,
    itemIds: [itemId],
    actorEmail: "tester@kf.local",
  });
  ok("re-confirm count", confirmRes.confirmed, 1);

  // --- snapshot AFTER
  const afterItem = personVisibleItem(db, itemId);
  const afterAlias = personVisibleAlias(db, "olive oil extra virgin 3 l", ingredientId);

  // --- The gate: every person-visible field matches
  ok("round-trip: item matches before", afterItem, beforeItem);
  ok("round-trip: alias matches before", afterAlias, beforeAlias);

  // --- Event rows expected (and allowed)
  const undoEvents = Array.from(db.pr_events.values()).filter((e) => e.kind === "review_undo");
  const confirmEvents = Array.from(db.pr_events.values()).filter((e) => e.kind === "review_confirm");
  ok("one review_undo event emitted", undoEvents.length, 1);
  ok("one review_confirm event emitted", confirmEvents.length, 1);

  // --- The ONLY person-invisible mutations: golden_links.verified_*
  // The test does not assert anything on those; it only confirms they
  // are the two columns that moved (not status, not link_status, not
  // any override).
  console.log("");
  console.log(`T7 send-back parity: ${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.log("");
    console.log("Ruling 2 says: STOP and report. Send back keeps its ask; no Undo is built.");
    process.exit(1);
  }
  console.log("Ruling 2 verdict: state parity holds; Send back can be flipped to one-click with Undo.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
