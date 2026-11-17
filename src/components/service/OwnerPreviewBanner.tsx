// The service lane's own preview banner. The People lane's banner
// links back to /people, which is wrong here. This one carries an
// Exit link back to the same /service address with the ?as= dropped.
//
// Styled from tokens; no raw hex, no raw rgb().

import Link from "next/link";

export function OwnerPreviewBanner({ name, exitHref }: { name: string; exitHref: string }) {
  return (
    <aside className="kf-sc-preview" role="status" aria-label="Owner preview">
      <span className="kf-sc-preview__word">
        <strong>Viewing as {name}.</strong>
        <span>Owner preview.</span>
      </span>
      <Link className="kf-sc-preview__exit" href={exitHref}>Exit preview</Link>
    </aside>
  );
}
