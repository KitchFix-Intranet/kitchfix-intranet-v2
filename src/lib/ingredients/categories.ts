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
