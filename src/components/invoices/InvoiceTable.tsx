// The desktop invoice table. Server-rendered. 48px rows, fixed
// layout, sticky header. Whole-row-clickable through <TableRowOpen>;
// the vendor cell holds a real button for the keyboard. "Credit"
// word precedes credit-row numbers (no second minus - credits
// already store negative).
//
// Column widths (fix pass 1, Chat-Claude ruling for a 940 px
// container):
//   Many-site: Site 100, Vendor fluid, Invoice 196, Sent 150,
//              Total 116, Status 172
//   One-site:  Vendor fluid, Invoice 196, Invoice date 112,
//              Sent 104, Total 116, Status 172
//
// Status and Total never clip. Invoice numbers past what 196 holds
// ellipsis with the full value in `title` and in the drawer. Vendor
// names ellipsis with the full value in the button's `title` and in
// the drawer.

import { fmtDate } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type { ListRowView, SiteNavItem } from "@/lib/invoices/types";
import { statusWordsFor } from "@/lib/invoices/statusWords";
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
          {manySites ? <col style={{ width: "100px" }} /> : null}
          <col />
          <col style={{ width: "196px" }} />
          {!manySites ? <col style={{ width: "112px" }} /> : null}
          <col style={{ width: manySites ? "150px" : "104px" }} />
          <col style={{ width: "116px" }} />
          <col style={{ width: "172px" }} />
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
                <td
                  className="kf-invoices-tcell kf-invoices-tcell--num kf-invoices-tcell--invnum"
                  title={invLabel}
                >
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
                  {(() => {
                    const w = statusWordsFor(r.status, r.v2Send, fixWord);
                    const toneClass = w.tone === "block" ? "kf-pill--block"
                      : w.tone === "warn" ? "kf-pill--warn"
                      : w.tone === "info" ? "kf-pill--info"
                      : w.tone === "good" ? "kf-pill--good"
                      : "kf-pill--muted";
                    return (
                      <span className={`kf-pill ${toneClass}`} title={w.sub ?? undefined}>
                        {w.label}
                      </span>
                    );
                  })()}
                </td>
              </TableRowOpen>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
