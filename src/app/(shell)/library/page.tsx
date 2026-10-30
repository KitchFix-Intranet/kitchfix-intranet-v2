// /library - Find. Server component. Loads a lean index of the 82
// Live documents (title, card_line, summary, keywords, doc_class,
// trains_you) via loadLibraryIndex and hands it to the Find client
// island, which filters in memory as the viewer types.
//
// Document-level search ONLY (R-AC10). Section-level search ("find
// the sentence inside a document") is a later train and needs an
// index over document_content that does not exist. Do not search
// document bodies here.
//
// The D1 Shelves page moved to /library/shelves. Reachable from the
// LIBRARY_NAV rail and from the no-match Find state.
//
// READ-ONLY. No write path.

import { requireAppAccess } from "@/lib/gate";
import { loadLibraryIndex } from "@/lib/academy/library";
import { loadRoom } from "@/lib/academy/room"; // viewer first-name only
import { IdentBand } from "@/components/ui/IdentBand";
import { LibraryFind } from "@/components/library/LibraryFind";
import "@/components/library/library.css";

function firstName(n: string | null | undefined): string | null {
  const t = (n ?? "").trim();
  if (!t) return null;
  return t.split(/\s+/)[0] || null;
}

export default async function Page() {
  const { email } = await requireAppAccess("/library");
  const result = await loadLibraryIndex(email);

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

  // Viewer first name via loadRoom (same identity path the rest of
  // Academy uses). Non-fatal if it fails.
  let name: string | null = null;
  try {
    const room = await loadRoom(email);
    if (room.ok) name = firstName(room.viewer.displayName);
  } catch {
    // non-fatal
  }

  const total = result.totalDocs;
  const trains = result.totalTrainsYou;
  const title = `Find a document, across ${total} live docs`;
  const kick = trains > 0
    ? `${trains} on your to-do list${name ? `, ${name}` : ""}. Type to find.`
    : "Type a title, a topic, or what you're trying to do.";
  const kickCapped = kick.length > 60 ? kick.slice(0, 60) : kick;

  return (
    <div className="kf-library">
      <IdentBand eyebrow="Library" title={title} kick={kickCapped} />
      <LibraryFind docs={result.docs} />
    </div>
  );
}
