// The desktop invoice table. Server-rendered. 48px rows, fixed
// layout, sticky header. Whole-row-clickable through <RowOpen>; the
// vendor cell holds a real button for the keyboard. "Credit" word
// precedes credit-row numbers (no second minus - credits already
// store negative).
//
// Column sets:
//   One site: Vendor, Invoice, Invoice date, Sent, Total, Status
//   Many sites: Site, Vendor, Invoice, Sent, Total, Status

import { fmtDate } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type { ListRowView, SiteNavItem } from "@/lib/invoices/types";
import { TableRowOpen, RowVendorButton } from "./RowOpen";

export function InvoiceTable({
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
  const siteName = (key: string) => sites.find((s) => s.accountKey === key)?.accountKey ?? key;
  return (
    <div className="kf-invoices-tablewrap">
      <table className="kf-invoices-table">
        <colgroup>
          {manySites ? <col style={{ width: "128px" }} /> : null}
          <col />
          <col style={{ width: "160px" }} />
          {!manySites ? <col style={{ width: "120px" }} /> : null}
          <col style={{ width: "160px" }} />
          <col style={{ width: "120px" }} />
          <col style={{ width: "148px" }} />
        </colgroup>
        <thead>
          <tr>
            {manySites ? <th scope="col">Site</th> : null}
            <th scope="col">Vendor</th>
            <th scope="col">Invoice</th>
            {!manySites ? <th scope="col">Invoice date</th> : null}
            <th scope="col">Sent</th>
            <th scope="col" className="kf-invoices-th--num">Total</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const href = openHref(r.id);
            const invLabel = r.kind === "credit" ? `Credit ${r.invoiceNumber}` : r.invoiceNumber;
            return (
              <TableRowOpen
                key={r.id}
                href={href}
                className={`kf-invoices-trow ${i % 2 === 1 ? "is-odd" : ""} ${r.status === "returned" ? "is-returned" : ""}`}
              >
                {manySites ? <td className="kf-invoices-tcell">{siteName(r.accountKey)}</td> : null}
                <td className="kf-invoices-tcell kf-invoices-tcell--vendor">
                  <RowVendorButton invId={r.id} href={href} vendorName={r.vendorName} />
                </td>
                <td className="kf-invoices-tcell kf-invoices-tcell--num kf-invoices-tcell--invnum">
                  {invLabel}
                </td>
                {!manySites ? (
                  <td className="kf-invoices-tcell">
                    {r.invoiceDate ? fmtDate(r.invoiceDate, "short") : "-"}
                  </td>
                ) : null}
                <td className="kf-invoices-tcell kf-invoices-tcell--sent">
                  <time dateTime={r.submittedAt} title={fmtDate(r.submittedAt, "time")}>
                    {fmtDate(r.submittedAt, "short")}
                  </time>
                  {manySites && r.submitterFirstName ? (
                    <span className="kf-invoices-tcell__sub"> · {r.submitterFirstName}</span>
                  ) : null}
                </td>
                <td className="kf-invoices-tcell kf-invoices-tcell--num">
                  {fmtUsdExact(r.totalAmount)}
                </td>
                <td className="kf-invoices-tcell kf-invoices-tcell--status">
                  {r.status === "returned" ? (
                    <span className="kf-pill kf-pill--block">{fixWord}</span>
                  ) : (
                    <span className="kf-pill kf-pill--muted">With accounting</span>
                  )}
                </td>
              </TableRowOpen>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
