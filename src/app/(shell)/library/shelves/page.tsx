// /library/shelves - Shelves (browse). Server component. Calls
// loadLibrary which returns only status='Live' documents grouped by
// shelf, with a trains-you marker per doc. Hands the shelves to a
// client island (<ShelvesBrowser>) that handles the shelf-selection
// interactivity.
//
// Moved to this subpath by D2: /library now lands on Find; Shelves
// is reachable from the LIBRARY_NAV sidebar and from the no-match
// Find state. The page body is identical to D1's /library page.
//
// READ-ONLY. No write path is reachable from here.

import { requireOwnerPage } from "@/lib/gate";
import { loadRoom } from "@/lib/academy/room"; // only to carry the viewer's name on the band
import { loadLibrary } from "@/lib/academy/library";
import { IdentBand } from "@/components/ui/IdentBand";
import { ShelvesBrowser } from "@/components/library/ShelvesBrowser";
import "@/components/library/library.css";

function firstName(n: string | null | undefined): string | null {
  const t = (n ?? "").trim();
  if (!t) return null;
  return t.split(/\s+/)[0] || null;
}

export default async function Page() {
  const { email } = await requireOwnerPage();
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

  // Pull viewer first name for the band greeting via loadRoom (same
  // identity path the Academy pages use). If it fails we just drop
  // the name - the Library still renders.
  let name: string | null = null;
  try {
    const room = await loadRoom(email);
    if (room.ok) name = firstName(room.viewer.displayName);
  } catch {
    // non-fatal
  }

  const trains = result.totalTrainsYou;
  const total = result.totalDocs;
  const title = `All ${total} live documents are current`;
  const kick = trains > 0
    ? `${trains} on your to-do list${name ? `, ${name}` : ""}. Browse by shelf.`
    : "Browse by shelf. Read anything; sign only what is on your to-do list.";
  const kickCapped = kick.length > 60 ? kick.slice(0, 60) : kick;

  return (
    <div className="kf-library">
      <IdentBand
        eyebrow="Library"
        title={title}
        kick={kickCapped}
      />
      <ShelvesBrowser shelves={result.shelves} />
    </div>
  );
}
