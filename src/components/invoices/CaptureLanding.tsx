// Capture landing. Server component.
//
// One-site viewer or an explicit ?site=: renders the drop zone +
// Latest sent + Drafts waiting for that site.
// Many-site viewer with no ?site: renders "Which site?".
//
// Preview banner (train 1's component) renders when the owner is
// previewing someone; writes refuse everywhere server-side.

import Link from "next/link";
import { IdentBand } from "@/components/ui/IdentBand";
import { fmtDate } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type { DraftView, SiteNavItem, InvoiceScope } from "@/lib/invoices/types";
import type { LatestSentRow } from "@/lib/invoices/latestSent";
import { DropZone } from "./DropZone";
import { OwnerPreviewBanner } from "./OwnerPreviewBanner";

export function CaptureLanding({
  scope,
  sites,
  siteSlug,
  siteAccountKey,
  drafts,
  latestSent,
  needsFixCount,
  asParam,
  previewName,
}: {
  scope: InvoiceScope;
  sites: readonly SiteNavItem[];
  siteSlug: string;                // the selected site's slug
  siteAccountKey: string;
  drafts: readonly DraftView[];
  latestSent: readonly LatestSentRow[];
  needsFixCount: number;
  asParam: string | null;
  previewName: string | null;
}) {
  const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";
  const siteNav = sites.find((s) => s.slug === siteSlug);
  const siteName = siteNav?.name ?? siteAccountKey;

  const title = drafts.length === 0 && latestSent.length === 0
    ? "Add this week's invoices"
    : drafts.length > 0
      ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting`
      : "Add invoices";
  const kick = drafts.length === 0
    ? "Drop a PDF or a picture to start."
    : "Open a draft to finish typing it.";

  return (
    <div className="kf-invoices-surface kf-inv-capture">
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices" /> : null}

      <IdentBand
        eyebrow={`${siteAccountKey} · Capture`}
        title={title}
        kick={kick}
      />

      {needsFixCount > 0 ? (
        <p className="kf-inv-sitting__hint">
          {needsFixCount === 1 ? "1 invoice needs a fix. " : `${needsFixCount} invoices need a fix. `}
          <Link href={`/invoices/list?site=${siteSlug}&show=fix${asQ ? `&${asQ.slice(1)}` : ""}`}>See it in the list.</Link>
        </p>
      ) : null}

      <DropZone siteSlug={siteSlug} asParam={asParam} screen="desk" />

      <div className="kf-inv-capture__columns">
        <section className="kf-inv-capture__pane">
          <h3>Drafts waiting</h3>
          {drafts.length === 0 ? (
            <p className="kf-inv-sitting__hint">Nothing yet. Drop a file above to start.</p>
          ) : (
            <ul className="kf-inv-capture__drafts">
              {drafts.map((d) => {
                const label = d.invoice_number ? `#${d.invoice_number}` : "Untyped";
                return (
                  <li key={d.id} className="kf-inv-capture__draft">
                    <Link href={`/invoices?site=${siteSlug}&draft=${d.id}${asQ ? `&${asQ.slice(1)}` : ""}`}>
                      {label} · {d.vendor_id ? "Vendor picked" : "Pick a vendor"}
                    </Link>
                    <span className="kf-inv-sitting__hint">
                      {fmtDate(d.updated_at, "short")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="kf-inv-capture__pane">
          <h3>Latest sent at {siteName}</h3>
          {latestSent.length === 0 ? (
            <p className="kf-inv-sitting__hint">Nothing sent yet.</p>
          ) : (
            <ul className="kf-inv-capture__latest">
              {latestSent.map((r) => (
                <li key={r.id}>
                  <Link href={`/invoices/list?site=${siteSlug}&inv=${encodeURIComponent(r.id)}${asQ ? `&${asQ.slice(1)}` : ""}`}>
                    <strong>{r.vendor_name || "-"}</strong>
                    <br />
                    <span className="kf-inv-capture__latest__meta">
                      {r.type === "credit" ? "Credit " : ""}{r.invoice_number} · {fmtUsdExact(r.total_amount)} · {fmtDate(r.submitted_at, "short")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
