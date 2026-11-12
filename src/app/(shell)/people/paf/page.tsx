// /people/paf - PAF form (T4a). Read-only shell + the three
// simplest sheets (one-time bonus, one-time deduction, gratuity)
// + Check + drafts. Owner-only, ?as= preview, ?for=<worker_id>
// direct entry, ?draft=<uuid> resume.
//
// Nothing here writes `submissions`, sends email or posts to
// Slack. The only mutation is through /api/people/drafts, which
// writes `people_drafts` exclusively and refuses under ?as=.

import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { loadTeam } from "@/lib/people/load";
import { loadDraft } from "@/lib/people/drafts";
import { inScope } from "@/lib/people/scope";
import { buildWhoSeesIt } from "@/lib/people/whoSeesIt";
import type { PeopleRow } from "@/lib/people/types";
import { PafFlow } from "@/components/people/paf/PafFlow";
import type { PafAction } from "@/components/people/paf/WhatStep";
import { OwnerPreviewBanner } from "@/components/people/OwnerPreviewBanner";
import { IdentBand } from "@/components/ui/IdentBand";
import "../people.css";
import "./paf.css";

type Step = "who" | "what" | "details" | "check";

function step(value: string | string[] | undefined, fallback: Step): Step {
  const v = (Array.isArray(value) ? value[0] : value) ?? "";
  if (v === "who" || v === "what" || v === "details" || v === "check") return v;
  return fallback;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    as?: string | string[];
    for?: string | string[];
    draft?: string | string[];
    step?: string | string[];
  }>;
}) {
  const { email: ownerEmail } = await requireOwnerPage();
  const sp = await searchParams;
  const asWorkerId = Array.isArray(sp.as) ? sp.as[0] : sp.as ?? null;
  const forWorkerId = Array.isArray(sp.for) ? sp.for[0] : sp.for ?? null;
  const draftId = Array.isArray(sp.draft) ? sp.draft[0] : sp.draft ?? null;

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, ownerEmail, asWorkerId, /* isOwner */ true);
  if (!viewer) {
    return (
      <>
        <IdentBand eyebrow="PAF" title="You are not on the roster yet" kick="Reach out to HR so your record is added." />
        <section className="kf-pe-empty">
          <strong>Nothing to show.</strong>
          <span>Once your record is active, PAF opens here.</span>
        </section>
      </>
    );
  }
  if (viewer.role === null) {
    return (
      <>
        {viewer.previewOf ? <OwnerPreviewBanner name={viewer.previewOf.display_name || viewer.display_name} /> : null}
        <IdentBand eyebrow="PAF" title={`Viewing as ${viewer.display_name}`} kick="This viewer cannot start a PAF." />
        <section className="kf-pe-empty">
          <strong>Nobody to show for this person.</strong>
          <span>Only corporate, regional, site-leader and site-manager viewers can start a PAF.</span>
        </section>
      </>
    );
  }

  const team = await loadTeam(sb, viewer);

  // Draft hydration. The owner_email filter inside loadDraft is the
  // sole enforcement point; a draft that is not the viewer's returns
  // null here and we 404 (never leak a 403 body).
  //
  // PREVIEW NOTE. Even though previews cannot WRITE, they can still
  // READ their own drafts via loadDraft - the filter uses the
  // viewer's work_email (not the ?as= target's), so a preview read
  // only sees the real owner's drafts. The PafFlow then refuses to
  // save updates while preview is active.
  const viewerOwnerEmail = (viewer.work_email ?? "").toLowerCase();
  let initial: {
    step: Step;
    draftId: string | null;
    personWorkerId: string | null;
    personName: string | null;
    personAccountKey: string | null;
    action: PafAction | null;
    amount: string;
    effectiveDate: string;
    explanation: string;
  } = {
    step: "who",
    draftId: null,
    personWorkerId: null,
    personName: null,
    personAccountKey: null,
    action: null,
    amount: "",
    effectiveDate: "",
    explanation: "",
  };
  if (draftId) {
    const draft = await loadDraft(sb, viewerOwnerEmail, draftId);
    if (!draft) notFound();
    const p = draft.payload as Record<string, unknown>;
    initial = {
      step: "details",
      draftId: draft.id,
      personWorkerId: (p.person_worker_id as string | null) ?? null,
      personName: draft.person_name ?? ((p.employeeName as string | null) ?? null),
      personAccountKey: (p.locationKey as string | null) ?? null,
      action: (draft.action_type as PafAction | null) ?? null,
      amount: String(p.amount ?? ""),
      effectiveDate: String(p.effectiveDate ?? ""),
      explanation: String(p.explanation ?? ""),
    };
  } else if (forWorkerId) {
    // ?for=<worker_id>. Same scope check as ?card=: out of scope is
    // notFound(). Loads a narrow projection just for the scope test
    // and the display name + account_key the flow needs.
    const rawQ = await sb
      .from("people")
      .select("worker_id, display_name, title, account_key, region, work_email, manager_worker_id, is_corp, is_salaried, is_site_leader, is_regional_director, pp_full_access, pp_review, status")
      .eq("status", "ACTIVE")
      .eq("worker_id", forWorkerId)
      .maybeSingle();
    const raw = (rawQ.data as PeopleRow | null) ?? null;
    if (!raw) notFound();
    const accQ = await sb.from("accounts").select("team_key, region");
    const accountRegionByKey = new Map<string, string | null>(
      (accQ.data ?? []).map((a) => [a.team_key, (a.region as string | null) ?? null]),
    );
    if (!inScope(viewer, raw, accountRegionByKey)) notFound();
    initial = {
      ...initial,
      step: "what",
      personWorkerId: raw.worker_id,
      personName: raw.display_name,
      personAccountKey: raw.account_key,
    };
  }
  // Explicit ?step= wins when it is consistent with what we loaded.
  initial.step = step(sp.step, initial.step);

  // Who-sees-it is always for the finance route in T4a (the three
  // selectable actions are finance). Build it once per load so the
  // Check step does not re-read the roster.
  const whoSeesIt = await buildWhoSeesIt(
    sb,
    viewer,
    initial.personAccountKey,
    initial.action,
  );

  const isPreview = viewer.previewOf !== null;

  return (
    <div className="kf-pe-surface">
      {viewer.previewOf ? <OwnerPreviewBanner name={viewer.previewOf.display_name || viewer.display_name} /> : null}
      <PafFlow
        initial={initial}
        team={{
          selfRow: team.selfRow,
          sites: team.sites,
          panels: team.panels,
          defaultSiteKey: team.defaultSiteKey,
          viewerWorkerId: viewer.worker_id,
          singleSiteView: viewer.role === "site_leader" || viewer.role === "site_manager",
        }}
        whoSeesIt={{
          route: whoSeesIt.route,
          reviewers: whoSeesIt.reviewers,
          copied: whoSeesIt.copied,
        }}
        isPreview={isPreview}
        asWorkerId={asWorkerId}
      />
    </div>
  );
}
