import Link from "next/link";
import { Lock } from "lucide-react";

type ActiveTab = "overview" | "review" | "vendor-items";

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
      <span
        className="kf-tab kf-tab--disabled"
        aria-disabled="true"
        title="Arrives after the first round of confirms (step 5 ingredient admin)"
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
