// /library - Find. Server component. Loads a lean index of the 82
// Live documents (title, card_line, summary, keywords, doc_class,
// updated_at) via loadLibraryIndex and hands it to the Find client
// island, which filters in memory as the viewer types.
//
// Document-level search ONLY (R-AC10). Section-level search ("find
// the sentence inside a document") is a later train and needs an
// index over document_content that does not exist. Do not search
// document bodies here.
//
// R-AC26 (F2): the Library is a reading product. No Academy
// linkage, no "N on your to-do list" copy. The band reads as the
// Library's own.
//
// READ-ONLY. No write path.

import { requireAppAccess } from "@/lib/gate";
import { loadLibraryIndex } from "@/lib/academy/library";
import { IdentBand } from "@/components/ui/IdentBand";
import { LibraryFind } from "@/components/library/LibraryFind";
import "@/components/library/library.css";

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

  const total = result.totalDocs;
  const title = `Find a document across ${total} live docs`;
  const kick = "Title, topic, or what you're trying to do.";

  return (
    <div className="kf-library">
      <IdentBand eyebrow="Library" title={title} kick={kick} />
      <LibraryFind docs={result.docs} />
    </div>
  );
}
