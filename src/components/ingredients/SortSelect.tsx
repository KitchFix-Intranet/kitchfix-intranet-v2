"use client";

// SortSelect is a Client Component. The onChange handler fires
// requestSubmit() on the enclosing <form method="get"> so the sort query
// updates server-side. The form + hidden input mean the control still
// posts even if JS is slow, but React still needs this to be a client
// island because an event handler cannot cross the RSC boundary.
// See docs/GOTCHAS.md #13.

export type SortKey = "spend" | "lines" | "last_seen";

export const SORT_LABELS: Record<SortKey, string> = {
  spend: "12-month spend, highest first",
  lines: "12-month lines, highest first",
  last_seen: "Last seen, newest first",
};

export function parseSort(v: string | undefined): SortKey {
  if (v === "lines" || v === "last_seen") return v;
  return "spend";
}

export function SortSelect({ value }: { value: SortKey }) {
  return (
    <form className="kf-sort" method="get" aria-label="Sort by">
      <input type="hidden" name="sort" value={value} />
      <select
        name="sort"
        defaultValue={value}
        aria-label="Sort by"
        onChange={(e) => {
          e.currentTarget.form?.requestSubmit();
        }}
      >
        {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
          <option key={k} value={k}>
            {SORT_LABELS[k]}
          </option>
        ))}
      </select>
    </form>
  );
}
