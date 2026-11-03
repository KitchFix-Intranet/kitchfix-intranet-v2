import Link from "next/link";

// R2: Resale slots between Ingredients and Vendor items. The dictionary
// of masters is split by the pr_ingredients.resale flag - recipe
// masters here, resale masters there. Both consume the same workbench
// (IngredientMasters) parameterized by mode.
type ActiveTab = "overview" | "review" | "ingredients" | "resale" | "vendor-items";

export function Tabs({ active }: { active: ActiveTab }) {
  return (
    <nav className="kf-tabs" aria-label="Ingredient sections">
      <Link
        href="/stockpot/ingredients"
        className={`kf-tab${active === "overview" ? " kf-tab--active" : ""}`}
      >
        Overview
      </Link>
      <Link
        href="/stockpot/ingredients/review"
        className={`kf-tab${active === "review" ? " kf-tab--active" : ""}`}
      >
        Review queue
      </Link>
      <Link
        href="/stockpot/ingredients/ingredients"
        className={`kf-tab${active === "ingredients" ? " kf-tab--active" : ""}`}
      >
        Ingredients
      </Link>
      <Link
        href="/stockpot/ingredients/resale"
        className={`kf-tab${active === "resale" ? " kf-tab--active" : ""}`}
      >
        Resale
      </Link>
      <Link
        href="/stockpot/ingredients/vendor-items"
        className={`kf-tab${active === "vendor-items" ? " kf-tab--active" : ""}`}
      >
        Vendor items
      </Link>
    </nav>
  );
}
