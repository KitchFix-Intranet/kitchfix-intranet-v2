// /academy/read/[requirementId] - the reader stub. Train B wires every
// To do row and the Continue CTA at a live route; train C ships the
// read-check-sign flow. For now, render a single card inside the sheet
// so no link 404s and nothing crashes.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireOwnerPage } from "@/lib/gate";
import "@/components/academy/academy.css";

export default async function Page({
  params,
}: {
  params: Promise<{ requirementId: string }>;
}) {
  // Gate is applied by the layout; call again so a direct hit still
  // notFound()s a non-owner. Params read so the type is enforced.
  await requireOwnerPage();
  await params;

  return (
    <div className="kf-sheet">
      <section className="kf-card kf-reader-stub" aria-label="Not yet">
        <h2 className="kf-reader-stub__title">This opens in the next update</h2>
        <p className="kf-reader-stub__body">
          The read-check-sign flow arrives soon. Your place is saved and
          your record is permanent; nothing you did is lost.
        </p>
        <Link href="/academy" className="kf-btn kf-btn--primary">
          <ArrowLeft size={16} strokeWidth={1.5} />
          <span>Back to To do</span>
        </Link>
      </section>
    </div>
  );
}
