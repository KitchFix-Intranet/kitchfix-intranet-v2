// /library - the bookcase. Library L2.
//
// One landing page. The loader runs L1's may-read rule before any
// count, shelf or search list is built; the data passed to the
// client already carries only what this viewer may read. See
// `src/lib/academy/library.ts`.
//
// R-AC26: the Library is a reading product. No Academy linkage, no
// trains-you copy.
//
// Departure from the render: the approved render puts the search
// inside the band. `IdentBand` has no slot for a control, and
// adding one is a shared-foundation change outside this lane. The
// search field sits directly under the band here instead; see the
// L2 report.
//
// READ-ONLY. No write path.

import Link from "next/link";
import { requireAppAccess } from "@/lib/gate";
import { ownerEmails } from "@/lib/supabase/env";
import { loadLibrary } from "@/lib/academy/library";
import { countOpenSuggestions } from "@/lib/academy/suggestions";
import { IdentBand } from "@/components/ui/IdentBand";
import { Bookcase } from "@/components/library/Bookcase";
import "@/components/library/library.css";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { email } = await requireAppAccess("/library");
  const [result, sp] = await Promise.all([loadLibrary(email), searchParams]);

  if (!result.ok) {
    return (
      <div className="kf-library">
        <IdentBand
          eyebrow="Library"
          title="Catalog unavailable"
          kick="Couldn't read the document catalog."
          status="failed"
          pageName="Library"
        />
      </div>
    );
  }

  const { totalDocs, totalShelves, shelves } = result;
  const headline = `${totalDocs} ${totalDocs === 1 ? "document" : "documents"} on ${totalShelves} ${totalShelves === 1 ? "shelf" : "shelves"}`;
  const kick = "Each one is the current version.";
  const initialQuery = typeof sp.q === "string" ? sp.q : "";

  // Owner-only "Suggestions" link. Hidden entirely when no open
  // notes are waiting, so a non-owner never sees the control and an
  // owner only sees it when there is something to do. The shell
  // menu is untouched.
  const isOwner = ownerEmails().has(email);
  const openSuggestions = isOwner ? await countOpenSuggestions() : 0;

  return (
    <div className="kf-library">
      <div className="kf-only-desktop">
        <IdentBand eyebrow="Library" title={headline} kick={kick} />
      </div>
      <header className="kf-lb-phonetop kf-only-phone" aria-label="Library">
        <h1 className="kf-lb-phonetop__t">{headline}</h1>
        <p className="kf-lb-phonetop__k">{kick}</p>
      </header>
      {isOwner && openSuggestions > 0 ? (
        <Link href="/library/suggestions" className="kf-lb-sugsnip">
          <strong>Suggestions</strong>
          <span className="kf-lb-sugsnip__n">{openSuggestions}</span>
          <span className="kf-lb-sugsnip__l">waiting</span>
        </Link>
      ) : null}

      <Bookcase
        shelves={shelves}
        totalDocs={totalDocs}
        totalShelves={totalShelves}
        initialQuery={initialQuery}
      />
    </div>
  );
}
