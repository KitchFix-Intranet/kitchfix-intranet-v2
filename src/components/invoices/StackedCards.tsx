// Stacked cards (narrow + phone layout). Grouped: "Needs a fix" at
// the top, then by day sent. Whole card opens the drawer via
// <CardRowOpen>; the vendor name is a real button for keyboard.

import { fmtDate } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type { ListRowView, SiteNavItem } from "@/lib/invoices/types";
import { CardRowOpen, RowVendorButton } from "./RowOpen";

export function StackedCards({
  rows,
  manySites,
  sites,
  fixWord,
  openHref,
}: {
  rows: readonly ListRowView[];
  manySites: boolean;
  sites: readonly SiteNavItem[];
  fixWord: string;
  openHref: (id: string) => string;
}) {
  const returned = rows.filter((r) => r.status === "returned");
  const sent = rows.filter((r) => r.status !== "returned");
  const sentGroups = groupByDate(sent);
  const siteName = (key: string) => sites.find((s) => s.accountKey === key)?.accountKey ?? key;

  return (
    <div className="kf-invoices-cards">
      {returned.length > 0 ? (
        <section className="kf-invoices-cards__group">
          <h3 className="kf-invoices-cards__groupheading">{fixWord}</h3>
          <ul className="kf-invoices-cards__list" role="list">
            {returned.map((r) => (
              <li key={r.id}>
                <Card row={r} manySites={manySites} siteLabel={siteName(r.accountKey)} fixWord={fixWord} openHref={openHref} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sentGroups.map(([key, rowsInGroup]) => (
        <section key={key} className="kf-invoices-cards__group">
          <h3 className="kf-invoices-cards__groupheading">{formatGroupHeading(key)}</h3>
          <ul className="kf-invoices-cards__list" role="list">
            {rowsInGroup.map((r) => (
              <li key={r.id}>
                <Card row={r} manySites={manySites} siteLabel={siteName(r.accountKey)} fixWord={fixWord} openHref={openHref} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Card({
  row,
  manySites,
  siteLabel,
  fixWord,
  openHref,
}: {
  row: ListRowView;
  manySites: boolean;
  siteLabel: string;
  fixWord: string;
  openHref: (id: string) => string;
}) {
  const href = openHref(row.id);
  const invLabel = row.kind === "credit" ? `Credit ${row.invoiceNumber}` : row.invoiceNumber;
  return (
    <CardRowOpen href={href} className={`kf-invoices-card ${row.status === "returned" ? "is-returned" : ""}`}>
      <div className="kf-invoices-card__head">
        <RowVendorButton invId={row.id} href={href} vendorName={row.vendorName} />
        {row.status === "returned" ? (
          <span className="kf-pill kf-pill--block">{fixWord}</span>
        ) : (
          <span className="kf-pill kf-pill--muted">With accounting</span>
        )}
      </div>
      <div className="kf-invoices-card__meta">
        <span className="kf-invoices-card__inv">{invLabel}</span>
        {manySites ? <span className="kf-invoices-card__dot" aria-hidden /> : null}
        {manySites ? <span className="kf-invoices-card__site">{siteLabel}</span> : null}
      </div>
      <div className="kf-invoices-card__row">
        <span className="kf-invoices-card__key">Sent</span>
        <time dateTime={row.submittedAt} title={fmtDate(row.submittedAt, "time")}>
          {fmtDate(row.submittedAt, "short")}
        </time>
        {row.submitterFirstName ? <span> · {row.submitterFirstName}</span> : null}
      </div>
      <div className="kf-invoices-card__row">
        <span className="kf-invoices-card__key">Total</span>
        <span className="kf-invoices-card__val">{fmtUsdExact(row.totalAmount)}</span>
      </div>
    </CardRowOpen>
  );
}

function groupByDate(rows: readonly ListRowView[]): [string, ListRowView[]][] {
  const groups = new Map<string, ListRowView[]>();
  for (const r of rows) {
    const day = r.submittedAt.slice(0, 10);
    const bucket = groups.get(day) ?? [];
    bucket.push(r);
    groups.set(day, bucket);
  }
  return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
}

function formatGroupHeading(day: string): string {
  // Group heading is the sent day; fmtDate handles date-only strings
  // without timezone drift (fmt.ts §isDateOnly).
  return fmtDate(day, "short");
}
