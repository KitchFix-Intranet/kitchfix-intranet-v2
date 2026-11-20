// Capture landing. Server component.
//
// Decides between four things:
//   - Which site? -> never here; the page.tsx redirects or renders
//     WhichSiteChooser before it mounts the landing.
//   - E "You are set" -> when the viewer has drafts AND every draft
//     is ready. Survives a reload (train 2b correction 6).
//   - The normal landing -> drop zone + Latest sent + Drafts waiting.
//
// On viewports <= 860 px the shared IdentBand is hidden (DESIGN §3)
// and a plain phone head carries the same title + kick. The phone
// order is: needs-fix note, drop zone, Drafts waiting, Latest sent
// (B10). On desk: band, needs-fix, [drop zone | Latest sent] at
// container >= 980, Drafts waiting below.

import Link from "next/link";
import { IdentBand } from "@/components/ui/IdentBand";
import { fmtDate, timeAgo } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type { DraftListView, SiteNavItem, InvoiceScope } from "@/lib/invoices/types";
import type { LatestSentRow, ReturnedRow } from "@/lib/invoices/latestSent";
import { DropZone } from "./DropZone";
import { DraftsWaitingList } from "./DraftsWaitingList";
import { OwnerPreviewBanner } from "./OwnerPreviewBanner";

export function CaptureLanding({
  scope,
  sites,
  siteSlug,
  siteAccountKey,
  siteName,
  drafts,
  latestSent,
  needsFixCount,
  needsFixPreview,
  asParam,
  previewName,
  manySites,
}: {
  scope: InvoiceScope;
  sites: readonly SiteNavItem[];
  siteSlug: string;
  siteAccountKey: string;
  siteName: string;
  drafts: readonly DraftListView[];
  latestSent: readonly LatestSentRow[];
  needsFixCount: number;
  needsFixPreview: readonly ReturnedRow[];
  asParam: string | null;
  previewName: string | null;
  manySites: boolean;
}) {
  const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";
  const asQAmp = asParam ? `&as=${encodeURIComponent(asParam)}` : "";
  const readyCount = drafts.filter((d) => d.ready).length;
  const restCount = drafts.length - readyCount;

  // Ignore `sites` and `manySites` beyond the import; the eyebrow
  // reads the selected site's key + name. Kept as props so a later
  // train can thread a site switch at the top if that lands.
  void sites; void manySites;

  // E branch (correction 6): has drafts and every one is ready.
  if (drafts.length > 0 && restCount === 0) {
    return (
      <div className="kf-invoices-surface kf-inv-capture">
        {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices" /> : null}
        <div className="kf-only-desktop">
          <IdentBand
            eyebrow={`${siteAccountKey} · ${siteName}`}
            title={`${readyCount} ready`}
            kick="Nothing has been sent yet. Sending is switched on in the next update."
          />
        </div>
        <div className="kf-inv-phonehead kf-only-phone">
          <h2 className="kf-inv-phonehead__title">
            {readyCount} ready
            <span className="kf-inv-phonehead__tick" aria-hidden />
          </h2>
          <p className="kf-inv-phonehead__kick">
            Nothing has been sent yet. Sending is switched on in the next update.
          </p>
        </div>

        <ul className="kf-inv-youareset">
          {drafts.map((d) => {
            const vendor = d.vendor_name ?? "No vendor yet";
            const label = d.invoice_number ? `#${d.invoice_number}` : "No number yet";
            const total = d.total_amount != null ? ` · ${fmtUsdExact(d.total_amount)}` : "";
            return (
              <li key={d.id}>
                <Link href={`/invoices?site=${siteSlug}&draft=${d.id}${asQAmp}`}>
                  <strong>{vendor}</strong>
                  <span>{label}{total}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="kf-inv-youareset__cta">
          <form action={`/invoices${asQ}`} method="get" style={{ display: "contents" }}>
            <input type="hidden" name="site" value={siteSlug} />
            {asParam ? <input type="hidden" name="as" value={asParam} /> : null}
          </form>
          <AddMoreButton siteSlug={siteSlug} asParam={asParam} />
          <Link
            className="kf-btn kf-btn--line"
            href={`/invoices/list?site=${siteSlug}${asQAmp}`}
          >
            See the list
          </Link>
        </div>
      </div>
    );
  }

  // Headline rules (correction 6, B1):
  //   drafts.length > 0: "{ready} ready, {rest} still to finish"
  //                      (singular adjustments)
  //   else:              "Add this week's invoices"
  const title = drafts.length > 0
    ? `${readyCount} ready, ${restCount} still to finish`
    : "Add this week's invoices";
  const kick = drafts.length > 0
    ? "Finish the ones below, or drop another file to start a new one."
    : "Drop a PDF or a picture to start.";

  // Needs-fix note: use the per-vendor preview when present;
  // fall back to a short count line when the preview comes back
  // empty but the chip count is >0 (shouldn't happen, but safe).
  const needsFixBlock =
    needsFixPreview.length > 0 ? (
      <aside className="kf-inv-needsfix" role="note">
        {needsFixPreview.map((r) => (
          <p key={r.id} className="kf-inv-needsfix__row">
            <span className="kf-inv-needsfix__name">
              {r.vendor_name} <span className="kf-inv-needsfix__num">#{r.invoice_number}</span> was sent back.
            </span>
            <Link
              className="kf-inv-needsfix__see"
              href={`/invoices/list?site=${siteSlug}&inv=${encodeURIComponent(r.id)}${asQAmp}`}
            >
              See it
            </Link>
          </p>
        ))}
      </aside>
    ) : needsFixCount > 0 ? (
      <aside className="kf-inv-needsfix" role="note">
        <p className="kf-inv-needsfix__row">
          <span>
            {needsFixCount === 1 ? "1 invoice needs a fix." : `${needsFixCount} invoices need a fix.`}
          </span>
          <Link
            className="kf-inv-needsfix__see"
            href={`/invoices/list?site=${siteSlug}&show=fix${asQAmp}`}
          >
            See it
          </Link>
        </p>
      </aside>
    ) : null;

  const latestBlock = latestSent.length > 0 ? (
    <section className="kf-inv-capture__pane kf-inv-latest-sent">
      <h3>Latest sent</h3>
      <ul className="kf-inv-capture__latest">
        {latestSent.map((r) => (
          <li key={r.id}>
            <Link
              href={`/invoices/list?site=${siteSlug}&inv=${encodeURIComponent(r.id)}${asQAmp}`}
              title={r.vendor_name}
            >
              <strong className="kf-inv-capture__latest__name">{r.vendor_name || "-"}</strong>
              <span className="kf-inv-capture__latest__meta">
                {r.type === "credit" ? "Credit " : ""}{r.invoice_number}
                {" · "}{fmtDate(r.submitted_at, "short")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link className="kf-inv-capture__latest__all" href={`/invoices/list?site=${siteSlug}${asQAmp}`}>
        See all
      </Link>
    </section>
  ) : (
    <section className="kf-inv-capture__pane">
      <h3>Latest sent</h3>
      <p className="kf-inv-sitting__hint">Nothing sent from this site yet.</p>
    </section>
  );

  const draftsBlock = (
    <section className="kf-inv-capture__pane">
      <h3>Drafts waiting</h3>
      {drafts.length === 0 ? (
        <p className="kf-inv-sitting__hint">Nothing yet. Drop a file above to start.</p>
      ) : (
        <DraftsWaitingList drafts={drafts} siteSlug={siteSlug} asParam={asParam} />
      )}
    </section>
  );

  return (
    <div className="kf-invoices-surface kf-inv-capture">
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices" /> : null}

      <div className="kf-only-desktop">
        <IdentBand
          eyebrow={`${siteAccountKey} · ${siteName}`}
          title={title}
          kick={kick}
        />
      </div>
      <div className="kf-inv-phonehead kf-only-phone">
        <h2 className="kf-inv-phonehead__title">
          {title}
          <span className="kf-inv-phonehead__tick" aria-hidden />
        </h2>
        <p className="kf-inv-phonehead__kick">{kick}</p>
      </div>

      {needsFixBlock}

      {/* Desk: drop zone + Latest sent beside each other at a
          container width of 980+. Phone: order is B4, B6, B5. The
          phone branch renders DropZone with screen="phone" so the
          wording + button change too. */}
      <div className="kf-inv-landing-grid kf-only-desktop">
        <div className="kf-inv-landing-grid__drop">
          <DropZone siteSlug={siteSlug} asParam={asParam} screen="desk" />
        </div>
        <div className="kf-inv-landing-grid__latest">
          {latestBlock}
        </div>
      </div>
      <div className="kf-inv-landing-stack kf-only-phone">
        <DropZone siteSlug={siteSlug} asParam={asParam} screen="phone" />
      </div>

      <div className="kf-only-desktop">{draftsBlock}</div>
      <div className="kf-only-phone">
        {draftsBlock}
        {latestBlock}
      </div>
    </div>
  );
}

// Small inline "Add more" that loops back to the landing without a
// server redirect round trip.
function AddMoreButton({ siteSlug, asParam }: { siteSlug: string; asParam: string | null }) {
  const asQAmp = asParam ? `&as=${encodeURIComponent(asParam)}` : "";
  return (
    <Link
      className="kf-btn kf-btn--primary"
      href={`/invoices?site=${siteSlug}${asQAmp}#add`}
    >
      Add more
    </Link>
  );
}

// Unused imports guard (timeAgo may be imported by the drafts list
// in a later tweak; keep it off here to satisfy lint).
void timeAgo;
