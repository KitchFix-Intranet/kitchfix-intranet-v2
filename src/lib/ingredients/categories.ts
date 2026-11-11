// Canonical super-category map for ingredients.
//
// Two-level categories: `parent` (sub-category, "Beef") sits inside a
// `category` (super-category, "Proteins"). The super-category is derived
// from the sub-category via CATEGORY_BY_PARENT - the matcher does not
// guess it, and the UI does not pick it independently. A null return
// from categoryForParent is intentional and surfaces as "Needs category"
// in the queue; the user resolves it there rather than being handed a
// wrong guess.
//
// This module is the single source of truth for the parent -> super
// map. The SAME map lives in the migration
// supabase/migrations/0008_ingredient_category.sql as a SQL CASE; a
// change to one is a change to the other in the SAME PR. Every ingredient
// insert, every ingredient-admin dropdown, every "Needs category" filter
// reads from here; do not inline a copy of the map anywhere else.
//
// 2026-11-09: added `Spices` and `Baking` in code only. 0008 is a one-time
// backfill and has already run; every pr_ingredients row with those
// parents already carries category='Pantry / Dry goods' (verified live),
// and zero rows have a null category. Editing an applied migration file
// would not change the database. A FUTURE parent addition still needs a
// fresh migration if any existing row would change; this exemption
// applies only when the live rows already carry the value the code is
// catching up to.

export const SUPER_CATEGORIES = [
  "Proteins",
  "Produce",
  "Dairy",
  "Pantry / Dry goods",
  "Prepared & frozen",
  "Bakery",
  "Beverages",
] as const;

export type SuperCategory = (typeof SUPER_CATEGORIES)[number];

export const CATEGORY_BY_PARENT: Readonly<Record<string, SuperCategory>> = {
  "Beef": "Proteins",
  "Chicken": "Proteins",
  "Pork": "Proteins",
  "Lamb and game": "Proteins",
  "Seafood": "Proteins",
  "Eggs": "Proteins",
  "Vegetables and herbs": "Produce",
  "Fruit": "Produce",
  "Dairy": "Dairy",
  "Sauces and bases": "Pantry / Dry goods",
  "Oils and vinegars": "Pantry / Dry goods",
  "Rice and grains": "Pantry / Dry goods",
  "Sweeteners": "Pantry / Dry goods",
  "Nuts and snacks": "Pantry / Dry goods",
  "Spices": "Pantry / Dry goods",
  "Baking": "Pantry / Dry goods",
  "Frozen and prepared": "Prepared & frozen",
  "Bakery": "Bakery",
  "Beverages": "Beverages",
};

// Returns the super-category for a given parent, or null if the parent
// is new/unmapped (surfaces as "Needs category"). A null parent returns
// null for the same reason.
export function categoryForParent(parent: string | null | undefined): SuperCategory | null {
  if (!parent) return null;
  return CATEGORY_BY_PARENT[parent] ?? null;
}

// Parents whose items are generally bought and sold by weight. Narrow by
// design: `each` is the right default for most of what the review queue
// creates (24 x 12 OZ Coca-Cola, protein bars, chips, string cheese,
// yogurt cups are all single-serve items packed in ounces), so Dairy,
// Bakery, Beverages, and Nuts and snacks are deliberately absent.
// Measured on live Postgres 2026-11-11: of the 170 masters created
// between 2026-11-09 and 2026-11-11 that all landed as `each`, only 14
// were wrong (11 lb, 3 gal) and all 14 sit under parents in this list
// or ship in GAL / QT. Widening the list past these seven would
// re-introduce the mis-tagging it is meant to prevent.
export const WEIGHT_PARENTS: ReadonlySet<string> = new Set([
  "Beef",
  "Chicken",
  "Pork",
  "Lamb and game",
  "Seafood",
  "Vegetables and herbs",
  "Fruit",
]);

// Decide the base_unit for a newly-created ingredient from its parent
// and the pack units of the vendor items it was split from. Returns
// one of three values:
//
//   "lb"   - every non-null pack uom is LB or OZ AND parent is a
//            WEIGHT_PARENTS member. Any disagreement, or any uom
//            outside {LB, OZ}, or a parent outside the set, falls
//            through to "each". OZ belongs here because catch-weight
//            and avg-weight items from meat/seafood commonly ship as
//            "8 OZ portions" but are still priced per lb.
//   "gal"  - every non-null pack uom is GAL or QT (any parent). This
//            is parent-agnostic by design: 4/1 GAL sanitizer, 4/1 GAL
//            olive oil, and 1 GAL milk are all correctly `gal`.
//   "each" - everything else, including an empty pack-uom list, any
//            null-only input, and any parent/uom disagreement. This
//            is the deliberate common case: Coca-Cola, protein bars,
//            chips, yogurt cups, string cheese.
//
// Pack uoms are compared case-insensitively. Null pack uoms are
// ignored (they come from pack strings the parser could not resolve,
// e.g. "ONLY" or a service line - they are not evidence either way).
// A null parent falls through to "each" by the WEIGHT_PARENTS check.
export function inferBaseUnit(
  parent: string | null,
  packUoms: Array<string | null>
): "lb" | "each" | "gal" {
  const normalized: string[] = [];
  for (const u of packUoms) {
    if (u == null) continue;
    normalized.push(u.toUpperCase());
  }
  if (normalized.length === 0) return "each";
  const allGalQt = normalized.every((u) => u === "GAL" || u === "QT");
  if (allGalQt) return "gal";
  const allLbOz = normalized.every((u) => u === "LB" || u === "OZ");
  if (allLbOz && parent != null && WEIGHT_PARENTS.has(parent)) return "lb";
  return "each";
}
