// Shared compact section header for the three working Ingredients
// tabs (Review queue, Ingredients, Vendor items). The Overview tab
// has its own IdentBand hero and is intentionally not routed through
// this component.
//
// Polish 4 (2026-11-02). Before: Review and Ingredients both open'd
// with bare <header><span.kf-eyebrow>...<h2>...<p.kf-ing__kicker>... ;
// Vendor items had no header at all. One shared compact header
// standardises the three tabs so the eyebrow, title scale, and
// one-line description sit in the same place on every tab, and gives
// Vendor items a title it was missing. Lighter than the Overview hero -
// no navy band, no CTA button in the header (primary actions live in
// the @topbar slot; the `action` prop here is reserved for future
// per-tab inline actions and left empty today).

import type { ReactNode } from "react";

export function SectionHeader({
  eyebrow,
  title,
  kicker,
  action,
}: {
  eyebrow: string;
  title: string;
  kicker?: string;
  action?: ReactNode;
}) {
  return (
    <header className="kf-section-header">
      <div className="kf-section-header__text">
        <span className="kf-eyebrow">{eyebrow}</span>
        <h2 className="kf-section-header__title">{title}</h2>
        {kicker ? <p className="kf-section-header__kicker">{kicker}</p> : null}
      </div>
      {action ? <div className="kf-section-header__action">{action}</div> : null}
    </header>
  );
}
