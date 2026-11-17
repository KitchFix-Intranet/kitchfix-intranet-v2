// Empty / no-access / not-matching states for the invoices surface.
// Server-rendered, token-only.

import Link from "next/link";

export function NoAccess() {
  return (
    <div className="kf-empty kf-invoices-empty" role="status">
      <div className="kf-empty__icon" aria-hidden />
      <h3>No invoices for you yet</h3>
      <p>Sent invoices land here for your site when the office opens the tool.</p>
    </div>
  );
}

export function NoRosterRow() {
  return (
    <div className="kf-empty kf-invoices-empty" role="status">
      <div className="kf-empty__icon" aria-hidden />
      <h3>We cannot find you on the roster</h3>
      <p>Ask the office to check your record.</p>
    </div>
  );
}

export function NothingYet({ siteName }: { siteName: string | null }) {
  return (
    <div className="kf-empty kf-invoices-empty" role="status">
      <div className="kf-empty__icon" aria-hidden />
      <h3>Nothing sent yet</h3>
      <p>
        {siteName ? `${siteName} has not sent an invoice yet.` : "No invoices on file yet."}
      </p>
    </div>
  );
}

export function NothingMatches({ fixWord, clearHref }: { fixWord: string; clearHref: string }) {
  return (
    <div className="kf-empty kf-invoices-empty" role="status">
      <div className="kf-empty__icon" aria-hidden />
      <h3>Nothing matches</h3>
      <p>Try a different search or a different filter.</p>
      <div className="kf-invoices-empty__cta">
        <Link href={clearHref} className="kf-btn kf-btn--line">Show everything</Link>
      </div>
      <span className="kf-sr-only" aria-hidden>{fixWord}</span>
    </div>
  );
}

export function NothingToFix({ fixWord }: { fixWord: string }) {
  return (
    <div className="kf-empty kf-invoices-empty" role="status">
      <div className="kf-empty__icon" aria-hidden />
      <h3>Nothing {fixWord.toLowerCase()}</h3>
      <p>Everything has moved on. Nice.</p>
    </div>
  );
}
