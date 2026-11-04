import Link from "next/link";

// R2: Retail slots between Ingredients and Vendor items. The dictionary
// of masters is split by the pr_ingredients.resale column (B7: the DB
// column keeps its old name - "resale" - because it sits in a CHECK
// constraint and in many queries; the UI word is Retail). Both tabs
// consume the same workbench (IngredientMasters) parameterized by
// mode.
type ActiveTab = "overview" | "review" | "ingredients" | "retail" | "vendor-items";

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
        href="/stockpot/ingredients/retail"
        className={`kf-tab${active === "retail" ? " kf-tab--active" : ""}`}
      >
        Retail
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
