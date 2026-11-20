"use client";

// Train 5a / F23: one Sort control, used on every tab that sorts. A
// labelled menu (the .kf-labelled + .kf-ctl primitives). One set of
// words for the same order across tabs, from the reference's
// SORT_WORDS at docs/renders/INGREDIENTS_V1_RENDER_REFERENCE.html.
// The default order on every tab stays "spend".

export type SortKey =
  | "spend"
  | "name"
  | "items"
  | "spread"
  | "last"
  | "vendor"
  // Legacy URL keys kept so bookmarks on Vendor items still work.
  | "lines"
  | "last_seen";

// Train 5a: the one vocabulary. Export so a test can diff against
// the reference without import gymnastics.
export const SORT_WORDS: Record<SortKey, string> = {
  spend: "Highest 12-month spend",
  name: "Name A to Z",
  items: "Most items",
  spread: "Widest price spread",
  last: "Bought most recently",
  vendor: "Vendor A to Z",
  // Legacy aliases - Vendor items keeps its URL state unchanged
  // (protected by the memo). These two labels match the words the
  // user has been seeing.
  lines: "Most lines",
  last_seen: "Bought most recently",
};

export function SortMenu<K extends SortKey>({
  value,
  options,
  onChange,
  label = "Sort",
  id,
}: {
  value: K;
  options: readonly K[];
  onChange: (next: K) => void;
  label?: string;
  id?: string;
}) {
  return (
    <label className="kf-labelled">
      {label}
      <select
        className="kf-ctl"
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as K)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {SORT_WORDS[o]}
          </option>
        ))}
      </select>
    </label>
  );
}
