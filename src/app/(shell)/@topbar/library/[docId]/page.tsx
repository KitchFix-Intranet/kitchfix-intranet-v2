// /library/[docId] topbar slot. Carries the back control + the
// four document tools (Details, Share, Print, Suggest an edit).
// The tools dispatch events the on-page DocControlsIsland listens
// for, so a tool press never changes the URL; the Back button is a
// plain <Link> so browser Back agrees with it.

import { loadDocument } from "@/lib/academy/document";
import { requireAppAccess } from "@/lib/gate";
import { BackLink } from "@/components/library/BackLink";
import { DocToolbar } from "@/components/library/DocToolbar";
import "@/components/library/library.css";

export default async function Page({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = await params;
  const { email } = await requireAppAccess(`/library/${docId}`);
  const result = await loadDocument(email, docId);
  // Restricted + unknown: still show Back; hide the tools.
  const show = result.ok && !result.emptyContent;
  const title = result.ok ? result.doc.title : docId;
  return (
    <div className="kf-lb-topbar">
      <BackLink />
      {show ? <DocToolbar docId={docId} docTitle={title} /> : null}
    </div>
  );
}
