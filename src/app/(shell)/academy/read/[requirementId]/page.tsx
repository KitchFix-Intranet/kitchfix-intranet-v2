// /academy/read/[requirementId] - real reader. Train C replaces the
// train B stub. Server component: gates, loads the module via the
// train A loader, and hands the full ModuleBody to the <Reader>
// client. The payload is pure data; no function props cross the RSC
// boundary (the loader already strips correct_option_id).

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireAppAccess } from "@/lib/gate";
import { loadModule } from "@/lib/academy/module";
import { Reader } from "@/components/academy/Reader";
import "@/components/academy/academy.css";

export default async function Page({
  params,
}: {
  params: Promise<{ requirementId: string }>;
}) {
  const { requirementId } = await params;
  const { email } = await requireAppAccess(`/academy/read/${requirementId}`);

  const result = await loadModule(email, requirementId);

  if (!result.ok) {
    // 400 (bad UUID), 404 (not found / not this worker's), 500 and
    // "no_roster_row" all land on the Next 404 - same discipline as
    // the owner gate (G-B).
    if (result.status === 400 || result.status === 404 || result.status === 500) {
      notFound();
    }
    // 409 part-locked: render the "opens after Part N" card inline
    // rather than 404 - this is a real surface the operator can
    // reach from the To do row's "After Part N" state (a direct
    // deep link).
    if (result.status === 409 && result.error === "part_locked") {
      const after = result.unlocks_after_part ?? 1;
      return (
        <div className="kf-sheet">
          <section className="kf-card kf-reader-stub" aria-label="Part locked">
            <h2 className="kf-reader-stub__title">
              This opens after Part {after}
            </h2>
            <p className="kf-reader-stub__body">
              Parts are read in order. Finish and sign Part {after} first,
              then this one opens on your To do list.
            </p>
            <Link href="/academy" className="kf-btn kf-btn--primary">
              <ArrowLeft size={16} strokeWidth={1.5} />
              <span>Back to To do</span>
            </Link>
          </section>
        </div>
      );
    }
    // Any other non-ok (nothing matched above) - treat as not found
    // rather than leaking a server error page.
    notFound();
  }

  return <Reader body={result} />;
}
