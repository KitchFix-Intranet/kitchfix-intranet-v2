// Lane-local owner preview banner. Three copies live in the repo
// (service, people, now invoices); listed in the PR body as a
// candidate for src/components/ui/.

import Link from "next/link";

export function OwnerPreviewBanner({
  name,
  exitHref,
}: {
  name: string;
  exitHref: string;
}) {
  return (
    <div className="kf-invoices-preview" role="status">
      <span className="kf-invoices-preview__label">Owner preview</span>
      <span className="kf-invoices-preview__name">Viewing as {name}</span>
      <Link href={exitHref} className="kf-btn kf-btn--sm kf-btn--line">
        Exit preview
      </Link>
    </div>
  );
}
