// Phone head (viewport <= 860 px). DESIGN §3 bars the identity band
// on phones, so this lane renders the same status headline + kick
// inline above the toolbar. The small red tick (§6) is a 56x5
// skew bar under the headline, same type as the eyebrow tick on
// desktop. Listed in the PR body as a candidate for a shared
// section head.

import { timeAgo } from "@/lib/fmt";
import type { InvoiceScope } from "@/lib/invoices/types";
import type { ListView } from "@/lib/invoices/load";

const KICK_CAP = 60;

export function PhoneHead({
  scope,
  listView,
  manySites,
  singleSiteName,
}: {
  scope: InvoiceScope;
  listView: ListView;
  manySites: boolean;
  singleSiteName: string | null;
}) {
  const fixCount = listView.chipCounts.fix;
  const acctCount = listView.chipCounts.acct;
  const title = fixCount === 0 ? "All caught up" : scope.words.fixPlural(fixCount);
  const kick = buildKick({
    fixCount, acctCount,
    returnedRows: listView.rows.filter((r) => r.status === "returned"),
    manySites, singleSiteName,
    fixWord: scope.words.fix,
  });
  return (
    <div className="kf-invoices-phonehead kf-only-phone">
      <h2 className="kf-invoices-phonehead__title">
        {title}
        <span className="kf-invoices-phonehead__tick" aria-hidden />
      </h2>
      <p className="kf-invoices-phonehead__kick">{kick}</p>
    </div>
  );
}

interface KickRow {
  accountKey: string;
  vendorName: string;
  rejection: { rejectedAt: string } | null;
  submittedAt: string;
}

function buildKick({
  fixCount,
  acctCount,
  returnedRows,
  manySites,
  singleSiteName,
  fixWord,
}: {
  fixCount: number;
  acctCount: number;
  returnedRows: KickRow[];
  manySites: boolean;
  singleSiteName: string | null;
  fixWord: string;
}): string {
  if (fixCount === 0) return `${acctCount} with accounting. Nothing for you to do.`;
  if (fixCount === 1) {
    const row = returnedRows[0];
    const when = row?.rejection ? timeAgo(row.rejection.rejectedAt) : row ? timeAgo(row.submittedAt) : "recently";
    const full = row?.vendorName ? `${row.vendorName} was sent back ${when}.` : `Sent back ${when}.`;
    if (full.length <= KICK_CAP) return full;
    return `${fixWord.charAt(0).toUpperCase()}${fixWord.slice(1)} ${when}.`;
  }
  const oldest = returnedRows
    .map((r) => r.rejection?.rejectedAt ?? r.submittedAt)
    .sort()
    [0];
  const when = oldest ? timeAgo(oldest) : "recently";
  if (!manySites || singleSiteName) return `The oldest was sent back ${when}.`;
  const sites = new Set(returnedRows.map((r) => r.accountKey));
  const n = sites.size || fixCount;
  return `At ${n} sites. The oldest was sent back ${when}.`;
}
