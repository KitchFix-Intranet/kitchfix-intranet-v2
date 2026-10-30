// /library/shelves - Shelves (browse). Server component. Calls
// loadLibrary which returns only status='Live' documents grouped by
// shelf. Hands the shelves to a client island (<ShelvesBrowser>)
// that handles the browse / sort interactivity.
//
// R-AC26 (F2): no Academy linkage, no trains-you copy. The
// catalogue is the catalogue - no "on your to-do list" marks here.
//
// READ-ONLY. No write path is reachable from here.

import { requireAppAccess } from "@/lib/gate";
import { loadLibrary } from "@/lib/academy/library";
import { IdentBand } from "@/components/ui/IdentBand";
import { ShelvesBrowser } from "@/components/library/ShelvesBrowser";
import "@/components/library/library.css";

export default async function Page() {
  const { email } = await requireAppAccess("/library/shelves");
  const result = await loadLibrary(email);

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

  const total = result.totalDocs;
  const title = `All ${total} live documents are current`;
  const kick = "Browse by shelf, kind or language.";

  return (
    <div className="kf-library">
      <IdentBand eyebrow="Library" title={title} kick={kick} />
      <ShelvesBrowser shelves={result.shelves} />
    </div>
  );
}
