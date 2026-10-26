"use client";

// SortSelect is a Client Component. The onChange handler fires
// requestSubmit() on the enclosing <form method="get"> so the sort query
// updates server-side. The form + hidden input mean the control still
// posts even if JS is slow, but React still needs this to be a client
// island because an event handler cannot cross the RSC boundary.
//
// The SortKey type and SORT_LABELS record live in ./sortKeys (plain
// module, no "use client"): a Server Component may render this component
// as JSX, but must never import and call a plain function or const
// exported from a "use client" file - that was the fourth RSC shape in
// docs/GOTCHAS.md #13.

import { type SortKey, SORT_LABELS } from "./sortKeys";

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
