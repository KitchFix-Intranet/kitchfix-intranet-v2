// "Show older" strip under the list. Server component; no state.
//
// Three states:
//   - everything shown (shown === total): the counter alone, no link
//   - more pages available AND under the walk cap: "Show older"
//     advances `?more` by one
//   - walk cap hit short of total: no link; a plain sentence tells
//     the reader to search or pick a site to narrow down. The
//     "X of Y" count stays true because Y is the chip count.

import Link from "next/link";
import { fmtCount } from "@/lib/fmt";

export function ShowOlder({
  shown,
  total,
  moreHref,
  anyFilter,
  capHit,
}: {
  shown: number;
  total: number;
  moreHref: string | null;
  anyFilter: boolean;
  capHit: boolean;
}) {
  if (total === 0) return null;
  return (
    <div className="kf-invoices-paging">
      <p className="kf-invoices-paging__status">
        Showing {fmtCount(shown)} of {fmtCount(total)}
        {anyFilter ? " (filtered)" : ""}
      </p>
      {capHit ? (
        <p className="kf-invoices-paging__hint">
          That is as many as this view loads at once. To see older, search or pick a site.
        </p>
      ) : moreHref ? (
        <Link href={moreHref} className="kf-btn kf-btn--line kf-btn--sm">
          Show older
        </Link>
      ) : null}
    </div>
  );
}
