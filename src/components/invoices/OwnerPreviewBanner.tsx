// Lane-local owner preview banner. Three copies live in the repo
// (service, people, now invoices); listed in the PR body as a
// candidate for src/components/ui/.
//
// Train 2b correction F3: the sentence reads
// "Viewing as {first name}. Look only: nothing you do here is
// saved." The banner is also used on /invoices/list; the same
// sentence applies - the list is already look-only for a
// previewing owner, so it reads true there too.

import Link from "next/link";
import { firstWord } from "@/lib/invoices/firstName";

export function OwnerPreviewBanner({
  name,
  exitHref,
}: {
  name: string;
  exitHref: string;
}) {
  const first = firstWord(name) ?? name;
  return (
    <div className="kf-invoices-preview" role="status">
      <span className="kf-invoices-preview__label">Owner preview</span>
      <span className="kf-invoices-preview__name">
        Viewing as {first}. Look only: nothing you do here is saved.
      </span>
      <Link href={exitHref} className="kf-btn kf-btn--sm kf-btn--line">
        Exit preview
      </Link>
    </div>
  );
}
