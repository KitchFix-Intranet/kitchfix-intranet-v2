"use client";

// URL-param drawer for an invoice detail. Gotcha 10: play the exit
// animation on the client BEFORE pushing the close href, otherwise
// the drawer unmounts the instant `?inv=` leaves the URL.
//
// Focus discipline: Escape closes, outside click closes, Tab is
// trapped inside the panel while open, and on close focus returns
// to the VISIBLE vendor button for the row - the table and card
// layouts each hold a button carrying `data-inv-id`; one is in a
// container with `display: none` at the current viewport. We pick
// the one that is currently laid out.
//
// Email discipline: `DetailRowView` strips `submitterEmail` and
// `rejection.rejectedBy`. The office-fallback label is "the office";
// no email can land in the markup here because the type does not
// carry one.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { X, CalendarClock } from "lucide-react";
import { fmtDate } from "@/lib/fmt";
import { fmtUsdExact } from "@/lib/invoices/money";
import type { DetailRowView } from "@/lib/invoices/types";

const EXIT_MS = 320;

export function Drawer({
  detail,
  siteLabel,
  closeHref,
  fixWord,
  invId,
}: {
  detail: DetailRowView;
  siteLabel: string;
  closeHref: string;
  fixWord: string;
  invId: string;
}) {
  const router = useRouter();
  const [exiting, setExiting] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    if (exiting) return;
    setExiting(true);
    window.setTimeout(() => {
      router.push(closeHref);
      // Focus the visible row button after the URL updates. Both
      // table and card layouts render a vendor button carrying
      // `data-inv-id="<id>"`; one is inside a `display: none`
      // ancestor at the current width. `offsetParent` is null for
      // elements that are not laid out (display:none or ancestor
      // display:none), so we pick the one that is.
      window.setTimeout(() => {
        const candidates = document.querySelectorAll<HTMLButtonElement>(
          `[data-inv-id="${cssEscape(invId)}"]`,
        );
        let target: HTMLButtonElement | null = null;
        for (const el of Array.from(candidates)) {
          if (el.offsetParent !== null) { target = el; break; }
        }
        (target ?? candidates[0] ?? null)?.focus();
      }, 40);
    }, EXIT_MS);
  }, [exiting, router, closeHref, invId]);

  // Escape, outside click, focus trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    };
    document.addEventListener("keydown", onKey, true);
    // Move initial focus onto the close button.
    panelRef.current?.querySelector<HTMLButtonElement>("[data-close]")?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [close]);

  const title = detail.vendorName || "Invoice";
  const invKindWord = detail.kind === "credit" ? "Credit" : "Invoice";

  // Future-date amber (§6: an invoice date more than 7 days in the
  // future shows "in the future, as typed"). An icon rides with the
  // words so the amber tone is not the only signal.
  const futureAmber = isFarFuture(detail.invoiceDate);

  // Fallback when the server could not resolve a first name for
  // the person who sent the row back. The `rejectedBy` email is
  // stripped from the server-side DetailRow before it reaches
  // this component, so the only alternative is the plain phrase.
  const rejectedBy = detail.rejection?.rejectedByFirstName ?? "the office";
  const daysAgo = detail.rejection
    ? Math.floor((Date.now() - Date.parse(detail.rejection.rejectedAt)) / (24 * 60 * 60 * 1000))
    : 0;

  const linesSentence = linesLine(detail);

  return (
    <>
      <div
        className={`kf-invoices-drawer__backdrop ${exiting ? "is-exiting" : ""}`}
        onClick={close}
        aria-hidden
      />
      <aside
        ref={panelRef}
        className={`kf-invoices-drawer ${exiting ? "is-exiting" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${invKindWord} ${detail.invoiceNumber || ""} - ${title}`}
      >
        <header className="kf-invoices-drawer__head">
          <button
            type="button"
            data-close
            className="kf-invoices-drawer__close"
            aria-label="Close"
            onClick={close}
          >
            <X size={20} strokeWidth={1.5} aria-hidden />
          </button>
          <h2 className="kf-invoices-drawer__title">{title}</h2>
          <p className="kf-invoices-drawer__subtitle">
            {invKindWord} {detail.invoiceNumber || "-"} · {siteLabel}
          </p>
        </header>

        <div className="kf-invoices-drawer__body">
          {detail.rejection ? (
            <section className="kf-invoices-drawer__block kf-invoices-drawer__block--sentback" aria-label="Send-back note">
              <h3>Sent back by {rejectedBy}, {fmtDate(detail.rejection.rejectedAt, "short")}
                {daysAgo > 14 ? <span> ({daysAgo} days ago)</span> : null}
              </h3>
              {detail.rejection.reason ? (
                <p className="kf-invoices-drawer__reason">{detail.rejection.reason}</p>
              ) : null}
              {detail.rejection.note ? (
                <p className="kf-invoices-drawer__note">{detail.rejection.note}</p>
              ) : null}
            </section>
          ) : (
            <section className="kf-invoices-drawer__block" aria-label="Where it stands">
              <h3>Where it stands</h3>
              <p>
                Sent to accounting ·{" "}
                <time dateTime={detail.submittedAt} title={fmtDate(detail.submittedAt, "time")}>
                  {fmtDate(detail.submittedAt, "time")}
                </time>
              </p>
            </section>
          )}

          <section className="kf-invoices-drawer__block" aria-label="What was sent">
            <h3>What was sent</h3>
            <dl className="kf-invoices-drawer__kv">
              <dt>{invKindWord} number</dt>
              <dd>{detail.invoiceNumber || "-"}</dd>
              <dt>Invoice date</dt>
              <dd>
                {detail.invoiceDate ? fmtDate(detail.invoiceDate, "short") : "-"}
                {futureAmber ? (
                  <span className="kf-invoices-drawer__amber">
                    {" "}
                    <CalendarClock size={14} strokeWidth={2} aria-hidden style={{ verticalAlign: "-2px" }} />
                    {" "}in the future, as typed
                  </span>
                ) : null}
              </dd>
              <dt>Total</dt>
              <dd className="kf-invoices-drawer__kv-num">{fmtUsdExact(detail.totalAmount)}</dd>
              <dt>Sent</dt>
              <dd>
                <time dateTime={detail.submittedAt} title={fmtDate(detail.submittedAt, "time")}>
                  {fmtDate(detail.submittedAt, "short")}
                </time>
                {detail.submitterFirstName ? <span> by {detail.submitterFirstName}</span> : null}
              </dd>
            </dl>
          </section>

          <section className="kf-invoices-drawer__block" aria-label="Coding">
            <h3>Coding</h3>
            {detail.gl.length === 0 ? (
              <p>No coding on file.</p>
            ) : (
              <dl className="kf-invoices-drawer__kv">
                {detail.gl.map((line, i) => (
                  <div key={`${line.code}-${i}`} className="kf-invoices-drawer__kv-pair">
                    <dt>{line.name}</dt>
                    <dd className="kf-invoices-drawer__kv-num">{fmtUsdExact(line.amount)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          <section className="kf-invoices-drawer__block" aria-label="The page">
            <h3>The page</h3>
            {detail.pageUrl ? (
              <p>
                <a className="kf-btn kf-btn--line kf-btn--sm" href={detail.pageUrl} target="_blank" rel="noopener noreferrer">
                  Open the page
                </a>{" "}
                {typeof detail.pageCount === "number" && detail.pageCount > 0 ? (
                  <span>
                    {detail.pageCount} {detail.pageCount === 1 ? "page" : "pages"} on file.
                  </span>
                ) : null}
              </p>
            ) : (
              <p>No page on file.</p>
            )}
            {linesSentence ? (
              <p className="kf-invoices-drawer__lines">{linesSentence}</p>
            ) : null}
          </section>
        </div>
      </aside>
    </>
  );
}

function linesLine(detail: DetailRowView): string | null {
  // "Lines are not read for this vendor." when the vendor has
  // extract_line_items = false. Otherwise show the count only when
  // it is >= 1 (so an unknown vendor flag paired with zero stored
  // lines stays quiet). "1 line" singular, "2 lines" plural.
  if (detail.extractLineItems === false) return "Lines are not read for this vendor.";
  const n = detail.lineCount;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? "line" : "lines"} read for the purchase record.`;
}

function isFarFuture(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const days = (t - Date.now()) / (24 * 60 * 60 * 1000);
  return days > 7;
}

// CSS.escape, except we polyfill for Node/SSR safety. We only ever
// quote a UUID / numeric id, so the character set is already safe,
// but we escape the handful of chars that could ever appear so this
// helper never emits an invalid selector regardless of id shape.
function cssEscape(s: string): string {
  if (typeof window !== "undefined" && (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape) {
    return (window as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}
