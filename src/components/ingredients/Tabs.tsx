import Link from "next/link";

type ActiveTab = "overview" | "review" | "ingredients" | "vendor-items";

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
        href="/stockpot/ingredients/vendor-items"
        className={`kf-tab${active === "vendor-items" ? " kf-tab--active" : ""}`}
      >
        Vendor items
      </Link>
    </nav>
  );
}
