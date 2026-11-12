// /people - My team (T2). Owner-only (R-PP1): requireOwnerPage()
// 404s every non-owner. The release flag + isOpenedPath are NOT
// touched here per prompt section 1.
//
// The page is read-only. No forms, no sends, no notices. All
// the UI's interactivity lives in client islands under
// src/components/people/.
//
// ?as=<worker_id> (owner preview) narrows scope wholesale; it
// grants nothing. Combined with ?card=<worker_id> it still runs
// scope enforcement against the (overridden) viewer: a person
// outside the preview-viewer's scope returns notFound() (pin 1).

import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { IdentBand } from "@/components/ui/IdentBand";
import { resolveViewer } from "@/lib/people/viewer";
import { loadTeam } from "@/lib/people/load";
import { loadPerson } from "@/lib/people/loadPerson";
import { inScope } from "@/lib/people/scope";
import type { PeopleRow } from "@/lib/people/types";
import { MyTeam } from "@/components/people/MyTeam";
import { QuickActions } from "@/components/people/QuickActions";
import { OwnerPreviewBanner } from "@/components/people/OwnerPreviewBanner";
import { PersonCardFrame } from "@/components/people/PersonCardFrame";
import { PersonCardBody } from "@/components/people/PersonCardBody";
import "./people.css";

// Owner gate is enforced upstream; `isOwner` for the ?as= override
// is read from `requireOwnerPage()`'s success path (any email that
// passes is an owner by definition).
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ as?: string | string[]; card?: string | string[]; site?: string | string[] }>;
}) {
  // requireOwnerPage() returns the signed-in email and 404s every
  // non-owner. Every email that reaches past this line is in
  // OWNER_EMAILS and is therefore eligible for the ?as= preview.
  const { email: ownerEmail } = await requireOwnerPage();
  const sp = await searchParams;
  const asWorkerId = Array.isArray(sp.as) ? sp.as[0] : sp.as ?? null;
  const cardWorkerId = Array.isArray(sp.card) ? sp.card[0] : sp.card ?? null;

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, ownerEmail, asWorkerId, /* isOwner */ true);

  if (!viewer) {
    return (
      <>
        <IdentBand eyebrow="People Portal" title="You are not on the roster yet" kick="Reach out to HR so your record is added." />
        <section className="kf-pe-empty">
          <strong>Nothing to show.</strong>
          <span>Once your record is active, your team will appear here.</span>
        </section>
      </>
    );
  }

  // Null role (hourly non-manager; can only land here via owner
  // preview). Per Kevin ruling 2026-11-11, empty-state copy reads
  // "Nobody to show for this person."
  if (viewer.role === null) {
    return (
      <>
        {viewer.previewOf ? <OwnerPreviewBanner name={viewer.previewOf.display_name || viewer.display_name} /> : null}
        <IdentBand eyebrow="People Portal" title={`Viewing as ${viewer.display_name}`} kick="This viewer has no team to see." />
        <section className="kf-pe-empty">
          <strong>Nobody to show for this person.</strong>
          <span>Only corporate, regional, site-leader and site-manager viewers have a team.</span>
        </section>
      </>
    );
  }

  const team = await loadTeam(sb, viewer);

  // If ?card=<worker_id> is set, enforce scope against THIS viewer
  // (whichever viewer is active after owner preview). A person
  // outside scope returns notFound() from the server - pin 1.
  let cardNode: React.ReactNode = null;
  if (cardWorkerId) {
    // Narrow projection for the scope check: only the flags +
    // account that inScope reads. personal_email, phone and the
    // other PII columns are NOT pulled here - loadPerson pulls
    // them below after the gate passes.
    const rawQ = await sb
      .from("people")
      .select("worker_id, display_name, title, account_key, region, work_email, manager_worker_id, is_corp, is_salaried, is_site_leader, is_regional_director, pp_full_access, pp_review, status")
      .eq("status", "ACTIVE")
      .eq("worker_id", cardWorkerId)
      .maybeSingle();
    const raw = (rawQ.data as PeopleRow | null) ?? null;
    if (!raw) notFound();
    // Scope lookup needs the account-region map. loadTeam already
    // built one, but building it fresh here keeps this branch
    // independent and small.
    const accQ = await sb.from("accounts").select("team_key, region");
    const accountRegionByKey = new Map<string, string | null>(
      (accQ.data ?? []).map((a) => [a.team_key, (a.region as string | null) ?? null]),
    );
    // PIN 1 enforcement. One call, server-side, same scope function
    // the roster uses. notFound() on a miss - no 403 body leak.
    if (!inScope(viewer, raw, accountRegionByKey)) notFound();
    const loaded = await loadPerson(sb, viewer, cardWorkerId);
    if (!loaded) notFound();
    cardNode = (
      <PersonCardFrame>
        <PersonCardBody person={loaded.person} />
      </PersonCardFrame>
    );
  }

  const bandTitle = viewer.role === "corporate" ? "Everyone" :
                    viewer.role === "regional_director" ? (viewer.region || "Your region") :
                    viewer.role === "site_leader" ? viewer.account_key :
                    /* site_manager */ viewer.account_key;

  return (
    // T2.1 fix 2 (2026-11-12). `.kf-pe-surface` defines --pe-floor
    // for every descendant; without it the search field + other
    // control rules fell back to the browser default and the
    // field rendered at 23px. The wrapper is purely a CSS custom-
    // property scope - no layout change.
    <div className="kf-pe-surface">
      {viewer.previewOf ? <OwnerPreviewBanner name={viewer.previewOf.display_name || viewer.display_name} /> : null}

      <IdentBand
        eyebrow={bandTitle}
        title={`Welcome, ${firstName(viewer.display_name)}`}
        facts={[
          { label: "People", value: String(team.totals.people) },
          { label: "Pending", value: String(team.totals.pending), tone: team.totals.pending > 0 ? "warn" : "muted" },
        ]}
      />

      {/* Phone head: a non-chrome second header that matches the
         render's kf-pe-phonehead pattern (shell topbar carries the
         real title + crumb; this gives phone a short restatement
         with the live counts). */}
      <div className="kf-pe-phonehead kf-only-phone">
        <span className="kf-eyebrow kf-eyebrow--plain">My team</span>
        <p className="kf-pe-phonehead__line">
          {bandTitle} · {team.totals.people} {team.totals.people === 1 ? "person" : "people"}
          {team.totals.pending > 0 ? ` · ${team.totals.pending} pending` : ""}
        </p>
      </div>

      <QuickActions />

      <MyTeam
        people={team.people}
        sites={team.sites}
        viewerWorkerId={viewer.worker_id}
        singleSiteView={viewer.role === "site_leader" || viewer.role === "site_manager"}
      />

      {cardNode}
    </div>
  );
}

function firstName(full: string): string {
  const n = (full || "").trim();
  if (!n) return "there";
  return n.split(/\s+/)[0] || n;
}
