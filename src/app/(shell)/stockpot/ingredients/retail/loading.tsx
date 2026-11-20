// Train 5a: Retail masters loading skeleton. Same shape as the
// Ingredients tab (the page renders the same IngredientMasters
// component with mode="resale"), no band.

import { Block } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-3)" }}
      aria-busy="true"
      aria-label="Loading"
    >
      <Block height={48} radius={0} />
      <div
        className="kf-only-desktop"
        style={{ display: "flex", gap: "var(--sp-sp-3)", flexWrap: "wrap" }}
      >
        <Block height={44} width={360} />
        <Block height={44} width={180} />
      </div>
      <div
        className="kf-only-desktop"
        style={{ display: "flex", gap: "var(--sp-sp-2)", flexWrap: "wrap" }}
      >
        {[92, 110, 96, 84, 120, 100].map((w, i) => (
          <Block key={i} height={36} width={w} radius={999} />
        ))}
      </div>
      <div
        className="kf-only-desktop"
        style={{
          display: "grid",
          gridTemplateColumns: "320px minmax(0, 1fr)",
          gap: "var(--sp-sp-3)",
        }}
      >
        <Block height={520} />
        <Block height={520} />
      </div>
      <div
        className="kf-only-phone"
        style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-3)" }}
      >
        <Block height={48} />
        {[56, 56, 56, 56, 56, 56].map((h, i) => (
          <Block key={i} height={h} />
        ))}
      </div>
    </div>
  );
}
