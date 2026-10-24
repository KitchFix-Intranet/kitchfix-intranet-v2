import Link from "next/link";

type ActiveTab = "overview" | "vendor-items";

export function Tabs({ active }: { active: ActiveTab }) {
  return (
    <nav className="kf-tabs" aria-label="Ingredient sections">
      <Link
        href="/stockpot/ingredients"
        className={`kf-tab${active === "overview" ? " kf-tab--active" : ""}`}
      >
        Overview
      </Link>
      <span className="kf-tab kf-tab--disabled" aria-disabled="true" title="Arrives in step 5">
        Review queue <small>step 5</small>
      </span>
      <span className="kf-tab kf-tab--disabled" aria-disabled="true" title="Arrives in step 5">
        Ingredients <small>step 5</small>
      </span>
      <Link
        href="/stockpot/ingredients/vendor-items"
        className={`kf-tab${active === "vendor-items" ? " kf-tab--active" : ""}`}
      >
        Vendor items
      </Link>
    </nav>
  );
}
