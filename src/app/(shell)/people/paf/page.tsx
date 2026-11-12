// /people/paf - PAF form. Owner-only, ?as= preview, ?for= direct
// entry, ?draft= resume. Expanded in T4b-1 to feed the new sheet
// state model + the accounts list used by Reclassification.
//
// Nothing here writes submissions, sends email or posts to Slack.
// The only mutation is through /api/people/drafts, which writes
// people_drafts exclusively and refuses under ?as=.

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
import { EMPTY_FIELDS, type SheetFields } from "@/components/people/paf/sheetFields";
import type { SelectOption } from "@/components/people/paf/Select";
import { bandsForClient } from "@/lib/people/payBands";
import type { PerDiemDay } from "@/lib/people/perDiem";
import "../people.css";
import "./paf.css";

type Step = "who" | "what" | "details" | "check";

function step(value: string | string[] | undefined, fallback: Step): Step {
  const v = (Array.isArray(value) ? value[0] : value) ?? "";
  if (v === "who" || v === "what" || v === "details" || v === "check") return v;
  return fallback;
}

// Hydrate SheetFields from a draft payload record. Unknown keys
// stay out (type cast is just for TypeScript narrowing). perDiemDays
// is the only non-string field - we validate structure on load so a
// malformed payload cannot crash the sheet.
function fieldsFromPayload(p: Record<string, unknown>): SheetFields {
  const grab = (k: keyof SheetFields): string => {
    const v = p[k];
    return typeof v === "string" ? v : "";
  };
  const rawDays = p.perDiemDays;
  const perDiemDays: PerDiemDay[] = Array.isArray(rawDays)
    ? rawDays.flatMap((row): PerDiemDay[] => {
        if (!row || typeof row !== "object") return [];
        const d = String((row as Record<string, unknown>).date ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
        const t = String((row as Record<string, unknown>).tier ?? "");
        return [{ date: d, tier: t }];
      })
    : [];
  return {
    amount: grab("amount"),
    effectiveDate: grab("effectiveDate"),
    lastDayWorked: grab("lastDayWorked"),
    actionGroup: (grab("actionGroup") as SheetFields["actionGroup"]),
    separationReason: grab("separationReason"),
    rehireEligible: (grab("rehireEligible") as SheetFields["rehireEligible"]),
    explanation: grab("explanation"),
    oldTitle: grab("oldTitle"),
    newTitle: grab("newTitle"),
    reclassChangeRate: (grab("reclassChangeRate") as SheetFields["reclassChangeRate"]),
    newRate: grab("newRate"),
    statusChangeDirection: grab("statusChangeDirection"),
    reclassFrom: grab("reclassFrom"),
    reclassTo: grab("reclassTo"),
    reclassTitleChange: (grab("reclassTitleChange") as SheetFields["reclassTitleChange"]),
    cellFrequency: (grab("cellFrequency") as SheetFields["cellFrequency"]),
    increaseType: grab("increaseType"),
    employeeLevel: (grab("employeeLevel") as SheetFields["employeeLevel"]),
    role: grab("role"),
    customRole: grab("customRole"),
    oldRate: grab("oldRate"),
    eligSeasonComplete: (grab("eligSeasonComplete") as SheetFields["eligSeasonComplete"]),
    eligNoDiscipline: (grab("eligNoDiscipline") as SheetFields["eligNoDiscipline"]),
    eligCertsCurrent: (grab("eligCertsCurrent") as SheetFields["eligCertsCurrent"]),
    eligManagerApproved: (grab("eligManagerApproved") as SheetFields["eligManagerApproved"]),
    locationKey: grab("locationKey"),
    locationName: grab("locationName"),
    travelStartDate: grab("travelStartDate"),
    travelEndDate: grab("travelEndDate"),
    perDiemDays,
    travelSupplementEnabled: (grab("travelSupplementEnabled") as SheetFields["travelSupplementEnabled"]),
    equipmentRequestType: (grab("equipmentRequestType") as SheetFields["equipmentRequestType"]),
    replacementReason: grab("replacementReason"),
    confirmReported: (grab("confirmReported") as SheetFields["confirmReported"]),
    currentDeviceDetails: grab("currentDeviceDetails"),
    equipmentShipTo: grab("equipmentShipTo"),
    equipmentNotes: grab("equipmentNotes"),
    confirmReturn: (grab("confirmReturn") as SheetFields["confirmReturn"]),
  };
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

  // Accounts: active rows only, labelled "TEAM - NAME" like the
  // render. Used by Reclassification + Travel site visited dropdowns
  // + Pay increase band resolution (via state).
  const acctQ = await sb.from("accounts").select("team_key, name, active, region, state");
  const accounts = (acctQ.data ?? []).filter((a) => a.active !== false);
  const accountOptions: readonly SelectOption[] = accounts
    .map((a) => ({
      value: a.team_key as string,
      label: `${a.team_key} - ${((a.name as string | null) ?? "").trim() || a.team_key}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const viewerOwnerEmail = (viewer.work_email ?? "").toLowerCase();

  // Resolve person identity for the SheetAbout second line
  // ("<title> · <club>"). The actual authoritative values live on
  // people + accounts; title is the person's role, site_name comes
  // from accounts.name for their account_key.
  async function enrichPerson(workerId: string, displayName: string | null, accountKey: string | null): Promise<{
    worker_id: string; display_name: string; account_key: string;
    title: string | null; site_name: string | null;
  }> {
    let title: string | null = null;
    let site_name: string | null = null;
    if (accountKey) {
      const match = accounts.find((a) => a.team_key === accountKey);
      if (match) site_name = ((match.name as string | null) ?? "").trim() || null;
    }
    const pQ = await sb.from("people").select("title").eq("worker_id", workerId).eq("status", "ACTIVE").maybeSingle();
    if (pQ.data) title = ((pQ.data.title as string | null) ?? "").trim() || null;
    return {
      worker_id: workerId,
      display_name: displayName ?? "",
      account_key: accountKey ?? "",
      title,
      site_name,
    };
  }

  let initial: {
    step: Step;
    draftId: string | null;
    person: Awaited<ReturnType<typeof enrichPerson>> | null;
    action: PafAction | null;
    fields: SheetFields;
  } = {
    step: "who",
    draftId: null,
    person: null,
    action: null,
    fields: EMPTY_FIELDS,
  };

  if (draftId) {
    const draft = await loadDraft(sb, viewerOwnerEmail, draftId);
    if (!draft) notFound();
    const p = draft.payload as Record<string, unknown>;
    const pwid = typeof p.person_worker_id === "string" ? p.person_worker_id : "";
    const enriched = pwid
      ? await enrichPerson(pwid, draft.person_name, typeof p.locationKey === "string" ? p.locationKey : null)
      : null;
    initial = {
      step: "details",
      draftId: draft.id,
      person: enriched,
      action: (draft.action_type as PafAction | null) ?? null,
      fields: fieldsFromPayload(p),
    };
  } else if (forWorkerId) {
    // ?for=<worker_id>. Same scope check as ?card=. The person row
    // is enriched with title + site_name for the SheetAbout line.
    const rawQ = await sb
      .from("people")
      .select("worker_id, display_name, title, account_key, region, work_email, manager_worker_id, is_corp, is_salaried, is_site_leader, is_regional_director, pp_full_access, pp_review, status")
      .eq("status", "ACTIVE")
      .eq("worker_id", forWorkerId)
      .maybeSingle();
    const raw = (rawQ.data as PeopleRow | null) ?? null;
    if (!raw) notFound();
    const accMap = new Map(accounts.map((a) => [a.team_key as string, (a.region as string | null) ?? null]));
    if (!inScope(viewer, raw, accMap)) notFound();
    const enriched = await enrichPerson(raw.worker_id, raw.display_name, raw.account_key);
    initial = {
      step: "what",
      draftId: null,
      person: enriched,
      action: null,
      fields: EMPTY_FIELDS,
    };
  }
  initial.step = step(sp.step, initial.step);

  const whoSeesIt = await buildWhoSeesIt(
    sb,
    viewer,
    initial.person?.account_key ?? null,
    initial.action,
  );

  const isPreview = viewer.previewOf !== null;

  // Pay bands for the client. bandsForClient is the ONLY function
  // that reads PAY_BANDS; the whole table never reaches the browser.
  // We resolve the state from the chosen person's account; if there
  // is no person yet, we hand the client a blank slice and the band
  // bar on the Pay increase sheet simply does not render.
  const personAccountKey = initial.person?.account_key ?? null;
  const personAcc = personAccountKey ? accounts.find((a) => a.team_key === personAccountKey) : null;
  const bands = bandsForClient(personAccountKey, (personAcc?.state as string | null) ?? null);

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
        accountOptions={accountOptions}
        bands={bands}
        isPreview={isPreview}
        asWorkerId={asWorkerId}
      />
    </div>
  );
}
