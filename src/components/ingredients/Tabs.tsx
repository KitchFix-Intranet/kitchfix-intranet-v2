import Link from "next/link";
import { Lock } from "lucide-react";

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
      <span
        className="kf-tab kf-tab--disabled"
        aria-disabled="true"
        title="Arrives with the review queue (step 5)"
      >
        <Lock size={14} strokeWidth={1.5} />
        Review queue
      </span>
      <span
        className="kf-tab kf-tab--disabled"
        aria-disabled="true"
        title="Arrives with the review queue (step 5)"
      >
        <Lock size={14} strokeWidth={1.5} />
        Ingredients
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
