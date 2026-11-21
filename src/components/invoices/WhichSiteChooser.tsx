// Which site? For multi-site viewers landing on /invoices with no
// ?site. Server component.
//
// A1 (desk): shared IdentBand with the scope's eyebrow. Kick stays
// at 60 chars (correction 10): "Pick one. It stays with every
// invoice you add."
// A2 (phone, <=860): no band; a plain phone head with a red tick.
// A3: each site row shows a draft count when there is at least one
// in-flight draft for that site.

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { IdentBand } from "@/components/ui/IdentBand";
import { OwnerPreviewBanner } from "./OwnerPreviewBanner";
import type { SiteNavItem, InvoiceScope } from "@/lib/invoices/types";

function scopeEyebrow(scope: InvoiceScope): string {
  switch (scope.kind) {
    case "owner": return "Every site · Capture";
    case "office": return "The office · Capture";
    case "regional_director": return "Your region · Capture";
    case "site_manager": return "Your site · Capture";
    default: return "Invoices · Capture";
  }
}

export function WhichSiteChooser({
  sites,
  draftCountsBySlug,
  scope,
  asParam,
  previewName,
}: {
  sites: readonly SiteNavItem[];
  draftCountsBySlug: Readonly<Record<string, number>>;
  scope: InvoiceScope;
  asParam: string | null;
  previewName: string | null;
}) {
  const asQ = asParam ? `&as=${encodeURIComponent(asParam)}` : "";
  const title = "Which site?";
  const kick = "Pick one. It stays with every invoice you add.";

  return (
    <div className="kf-invoices-surface kf-inv-capture">
      {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices" /> : null}

      <div className="kf-only-desktop">
        <IdentBand eyebrow={scopeEyebrow(scope)} title={title} kick={kick} />
      </div>
      <div className="kf-inv-phonehead kf-only-phone">
        <h2 className="kf-inv-phonehead__title">
          {title}
          <span className="kf-inv-phonehead__tick" aria-hidden />
        </h2>
        <p className="kf-inv-phonehead__kick">{kick}</p>
      </div>

      <ul className="kf-inv-capture__sites">
        {sites.map((s) => {
          const n = draftCountsBySlug[s.slug] ?? 0;
          return (
            <li key={s.accountKey}>
              <Link href={`/invoices?site=${s.slug}${asQ}`}>
                <span className="kf-inv-capture__sites__main">
                  <span className="kf-inv-capture__sites__name">{s.accountKey}</span>
                  {s.name && s.name !== s.accountKey ? (
                    <span className="kf-inv-capture__sites__sub">{s.name}</span>
                  ) : null}
                </span>
                {n > 0 ? (
                  <span className="kf-inv-capture__sites__count">
                    {n} {n === 1 ? "draft" : "drafts"}
                  </span>
                ) : null}
                <ChevronRight className="kf-inv-capture__sites__chev" size={18} aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
