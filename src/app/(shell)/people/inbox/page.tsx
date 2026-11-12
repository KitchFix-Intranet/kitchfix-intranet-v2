// /people/inbox - Inbox (T3, read-only). Owner-only (R-PP1):
// requireOwnerPage() 404s every non-owner. `?as=<worker_id>` is the
// same owner preview as /people; it narrows wholesale, grants
// nothing.
//
// One write: when a viewer opens a record (?rec=<id>) that is not
// yet in people_record_opens for them, we insert exactly one row.
// This is suppressed under ?as= so a preview can never mark things
// read for the real viewer.

import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { IdentBand } from "@/components/ui/IdentBand";
import { resolveViewer } from "@/lib/people/viewer";
import { loadInbox } from "@/lib/people/loadInbox";
import { loadRecord, mayOpen, markOpened } from "@/lib/people/loadRecord";
import { Inbox } from "@/components/people/Inbox";
import { OwnerPreviewBanner } from "@/components/people/OwnerPreviewBanner";
import { PersonCardFrame } from "@/components/people/PersonCardFrame";
import { RecordDrawerBody } from "@/components/people/RecordDrawerBody";
import "../people.css";
import "./inbox.css";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ as?: string | string[]; rec?: string | string[] }>;
}) {
  const { email: ownerEmail } = await requireOwnerPage();
  const sp = await searchParams;
  const asWorkerId = Array.isArray(sp.as) ? sp.as[0] : sp.as ?? null;
  const recordId = Array.isArray(sp.rec) ? sp.rec[0] : sp.rec ?? null;

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, ownerEmail, asWorkerId, /* isOwner */ true);
  if (!viewer) {
    return (
      <>
        <IdentBand eyebrow="Inbox" title="You are not on the roster yet" kick="Reach out to HR so your record is added." />
        <section className="kf-pe-empty">
          <strong>Nothing to show.</strong>
          <span>Once your record is active, your inbox will appear here.</span>
        </section>
      </>
    );
  }
  if (viewer.role === null) {
    return (
      <>
        {viewer.previewOf ? <OwnerPreviewBanner name={viewer.previewOf.display_name || viewer.display_name} /> : null}
        <IdentBand eyebrow="Inbox" title={`Viewing as ${viewer.display_name}`} kick="This viewer has no inbox to see." />
        <section className="kf-pe-empty">
          <strong>Nothing to show for this person.</strong>
          <span>Only corporate, regional, site-leader and site-manager viewers have an inbox.</span>
        </section>
      </>
    );
  }

  const view = await loadInbox(sb, viewer);

  // Optional record drawer. The may-open check gates both the load
  // and the mark-opened write.
  let recordNode: React.ReactNode = null;
  if (recordId) {
    // Narrow projection only for the gate. loadRecord runs its own
    // SELECT with the payload.
    const rawQ = await sb
      .from("submissions")
      .select("id, module, action_type, status, submitted_at, admin_action_at, submitter_worker_id, person_worker_id, notes, payload")
      .eq("id", recordId)
      .maybeSingle();
    if (rawQ.error || !rawQ.data) notFound();
    const canOpen = await mayOpen(sb, viewer, rawQ.data as Parameters<typeof mayOpen>[2]);
    if (!canOpen) notFound();
    const loaded = await loadRecord(sb, viewer, recordId);
    if (!loaded) notFound();

    // PREVIEW GUARD. Never write while ?as= is active: an owner
    // preview must not mark records read for the previewed worker.
    // `viewer.previewOf` is non-null exactly when ?as= resolved to a
    // different person than the signed-in owner (see viewer.ts).
    const isPreview = viewer.previewOf !== null;
    if (!isPreview) {
      await markOpened(sb, viewer.worker_id, recordId);
    }

    recordNode = (
      <PersonCardFrame>
        <RecordDrawerBody record={loaded.view} />
      </PersonCardFrame>
    );
  }

  return (
    <div className="kf-pe-surface">
      {viewer.previewOf ? <OwnerPreviewBanner name={viewer.previewOf.display_name || viewer.display_name} /> : null}

      <IdentBand
        eyebrow="Inbox"
        title={view.band.title}
        facts={[
          { label: "Pending", value: String(view.band.pending_count), tone: view.band.needs_count > 0 ? "warn" : "muted" },
          { label: "Just decided", value: String(view.band.news_count) },
        ]}
      />

      {/* Phone head: eyebrow + one line of live counts. */}
      <div className="kf-pe-phonehead kf-only-phone">
        <span className="kf-eyebrow kf-eyebrow--plain">Inbox</span>
        <p className="kf-pe-phonehead__line">{view.band.phone_line}</p>
      </div>

      <Inbox view={view} />

      {recordNode}
    </div>
  );
}
