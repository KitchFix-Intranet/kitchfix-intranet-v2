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

import { requireAppAccess } from "@/lib/gate";
import { loadLibrary } from "@/lib/academy/library";
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

  return (
    <div className="kf-library">
      <div className="kf-only-desktop">
        <IdentBand eyebrow="Library" title={headline} kick={kick} />
      </div>
      <header className="kf-lb-phonetop kf-only-phone" aria-label="Library">
        <h1 className="kf-lb-phonetop__t">{headline}</h1>
        <p className="kf-lb-phonetop__k">{kick}</p>
      </header>

      <Bookcase
        shelves={shelves}
        totalDocs={totalDocs}
        totalShelves={totalShelves}
        initialQuery={initialQuery}
      />
    </div>
  );
}
