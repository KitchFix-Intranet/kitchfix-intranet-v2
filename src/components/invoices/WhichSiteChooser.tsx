// Which site? For multi-site viewers landing on /invoices with no
// ?site. Server component.

import Link from "next/link";
import { IdentBand } from "@/components/ui/IdentBand";
import type { SiteNavItem } from "@/lib/invoices/types";

export function WhichSiteChooser({
  sites,
  asParam,
  previewName,
}: {
  sites: readonly SiteNavItem[];
  asParam: string | null;
  previewName: string | null;
}) {
  const asQ = asParam ? `&as=${encodeURIComponent(asParam)}` : "";
  return (
    <div className="kf-invoices-surface kf-inv-capture">
      {previewName ? (
        <div className="kf-invoices-preview" role="status">
          <span className="kf-invoices-preview__label">Owner preview</span>
          <span className="kf-invoices-preview__name">Viewing as {previewName}</span>
          <Link href="/invoices" className="kf-btn kf-btn--sm kf-btn--line">Exit preview</Link>
        </div>
      ) : null}
      <IdentBand
        eyebrow="Invoices · Capture"
        title="Which site?"
        kick="Pick a site to start adding invoices."
      />
      <ul className="kf-inv-capture__sites">
        {sites.map((s) => (
          <li key={s.accountKey}>
            <Link href={`/invoices?site=${s.slug}${asQ}`}>
              <span>{s.accountKey}</span>
              <span aria-hidden>&gt;</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
