// Invoices head band (desktop). Wraps the shared IdentBand with
// the status headline + kick built from the list view. No facts
// (§6 "No band facts"). CTA shows "Show the N" when there is
// anything to fix AND the viewer is not the office.

import { IdentBand } from "@/components/ui/IdentBand";
import { timeAgo } from "@/lib/fmt";
import type { InvoiceScope } from "@/lib/invoices/types";
import type { ListView } from "@/lib/invoices/load";

const KICK_CAP = 60;

export function HeadBand({
  scope,
  listView,
  eyebrow,
  showFixHref,
  addInvoicesHref,
  manySites,
  singleSiteName,
}: {
  scope: InvoiceScope;
  listView: ListView;
  eyebrow: string;
  showFixHref: string;
  addInvoicesHref: string | null;   // non-null only for site / RD viewers
  manySites: boolean;
  singleSiteName: string | null;
}) {
  const fixCount = listView.chipCounts.fix;
  const acctCount = listView.chipCounts.acct;
  const title = fixCount === 0
    ? "All caught up"
    : scope.words.fixPlural(fixCount);

  const kick = buildKick({
    fixCount,
    acctCount,
    returnedRows: listView.rows.filter((r) => r.status === "returned"),
    manySites,
    singleSiteName,
    fixWord: scope.words.fix,
  });

  // Train 2 (§3): when there is nothing to fix, a site or regional
  // viewer gets "Add invoices" linking to /invoices. The office does
  // not get a Capture CTA; the owner can still use it.
  let cta: { label: string; href: string } | undefined = undefined;
  if (fixCount > 0 && scope.kind !== "office") {
    cta = { label: `Show the ${fixCount}`, href: showFixHref };
  } else if (fixCount === 0 && addInvoicesHref) {
    cta = { label: "Add invoices", href: addInvoicesHref };
  }

  return (
    <HeadBandView
      eyebrow={eyebrow}
      title={title}
      kick={kick}
      cta={cta}
    />
  );
}

function HeadBandView({
  eyebrow,
  title,
  kick,
  cta,
}: {
  eyebrow: string;
  title: string;
  kick: string;
  cta?: { label: string; href: string };
}) {
  return (
    <IdentBand
      eyebrow={eyebrow}
      title={title}
      kick={kick}
      cta={cta}
      facts={[]}
    />
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
  // Nothing to fix.
  if (fixCount === 0) {
    const n = acctCount;
    return `${n} with accounting. Nothing for you to do.`;
  }
  // Exactly one to fix: "{Vendor} was sent back {time ago}."
  if (fixCount === 1) {
    const row = returnedRows[0];
    const when = row?.rejection ? timeAgo(row.rejection.rejectedAt) : row ? timeAgo(row.submittedAt) : "recently";
    const full = row?.vendorName
      ? `${row.vendorName} was sent back ${when}.`
      : `Sent back ${when}.`;
    if (full.length <= KICK_CAP) return full;
    return `${capitaliseFirst(fixWord)} ${when}.`;
  }
  // Several to fix. Pick the oldest rejection date.
  const oldest = oldestRejection(returnedRows);
  const when = oldest ? timeAgo(oldest) : "recently";
  if (!manySites || singleSiteName) {
    return `The oldest was sent back ${when}.`;
  }
  // Many sites: count distinct accountKeys in returnedRows.
  const sites = new Set(returnedRows.map((r) => r.accountKey));
  const n = sites.size || fixCount;
  return `At ${n} sites. The oldest was sent back ${when}.`;
}

function oldestRejection(
  rows: { rejection: { rejectedAt: string } | null; submittedAt: string }[],
): string | null {
  let oldest: string | null = null;
  for (const r of rows) {
    const t = r.rejection?.rejectedAt ?? r.submittedAt;
    if (!oldest || Date.parse(t) < Date.parse(oldest)) oldest = t;
  }
  return oldest;
}

function capitaliseFirst(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}
