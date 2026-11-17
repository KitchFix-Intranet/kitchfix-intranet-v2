// Shell-level loading state for /invoices/list. Content-equal skeleton
// heights: band (128px), toolbar (~56px), table rows (48px) x 10.

import "@/components/invoices/invoices.css";

export default function Loading() {
  return (
    <div className="kf-invoices-surface" aria-busy="true">
      <div className="kf-band kf-only-desktop kf-skel kf-skel--navy" style={{ height: "var(--sp-band)" }} />
      <div className="kf-invoices-phonehead kf-only-phone">
        <div className="kf-skel kf-skel--line" style={{ width: "60%", height: 28 }} />
        <div className="kf-skel kf-skel--line" style={{ width: "80%", height: 18, marginTop: 8 }} />
      </div>
      <div className="kf-invoices-toolbar kf-skel kf-skel--line" style={{ height: 56 }} />
      <div className="kf-invoices-list">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="kf-skel kf-skel--line" style={{ height: 48, marginTop: 8 }} />
        ))}
      </div>
    </div>
  );
}
