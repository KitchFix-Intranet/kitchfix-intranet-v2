// /invoices - Capture. Replaces train 1's redirect (the list stays
// at /invoices/list).
//
// No `site`: one-site viewer -> redirect to their site; many-site
// viewer -> "Which site?". No sites -> NoAccess.
// With `site`, no `draft`: the landing.
// With `site` and `draft`: the sitting.
//
// Train 2b correction 4.5: no signed storage URL is built here or
// passed to any client component.
// Train 2b fix-before-push #6 / F4: no segment-level loading.tsx
// (it cannot see `?draft=`, so a sitting load would flash the
// landing skeleton). Instead, Page() reads searchParams and wraps
// the heavy data-loading branch in its own Suspense boundary with
// the matching skeleton. The viewer/scope reads happen at the top
// where they are cheap and needed by both paths; they stream in
// before the Suspense fallback shows. No path crosses skeletons.

import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { ownerEmails } from "@/lib/supabase/env";
import { loadInvoiceSites } from "@/lib/invoices/accessList";
import { resolveInvoiceScope, sitesInScope, isManySites } from "@/lib/invoices/scope";
import { slugToAccountKey, accountKeyToSlug } from "@/lib/invoices/slug";
import { isInvoiceAdmin } from "@/lib/invoices/load";
import {
  listDraftsForOwnerSite, listDraftsForOwnerSiteFixedOrder, toDraftView,
  getDraftById, listFilesForDraft, toFileView,
} from "@/lib/invoices/draftLoad";
import { buildDraftListView } from "@/lib/invoices/draftListView";
import { loadLatestSent, loadReturnedForSite } from "@/lib/invoices/latestSent";
import { loadActiveCodesForSite, loadUsualCodes } from "@/lib/invoices/glCodes";
import { outboundMode } from "@/lib/invoices/outboundGate";
import { loadRecentlySent } from "@/lib/invoices/recentlySent";
import { CaptureLanding } from "@/components/invoices/CaptureLanding";
import { WhichSiteChooser } from "@/components/invoices/WhichSiteChooser";
import { CaptureSittingRoot } from "@/components/invoices/CaptureSittingRoot";
import { OwnerPreviewBanner } from "@/components/invoices/OwnerPreviewBanner";
import { NoAccess, NoRosterRow } from "@/components/invoices/EmptyStates";
import { IdentBand } from "@/components/ui/IdentBand";
import { LandingSkeleton, SittingSkeleton } from "@/components/invoices/CaptureSkeletons";
import type { InvoiceScope, SiteNavItem } from "@/lib/invoices/types";
import "@/components/invoices/invoices.css";
import "@/components/invoices/capture.css";

interface Shared {
  scope: InvoiceScope;
  nav: readonly SiteNavItem[];
  manySites: boolean;
  slug: string;
  accountKey: string;
  ownerEmail: string;
  asParam: string | null;
  previewName: string | null;
  isPreview: boolean;
  siteName: string;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ site?: string | string[]; draft?: string | string[]; as?: string | string[] }>;
}) {
  const { email } = await requireOwnerPage();
  const sp = await searchParams;
  const site = pickOne(sp.site);
  const draftId = pickOne(sp.draft);
  const as = pickOne(sp.as);

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, email, as, true);
  const isOwnerNotPreviewing = ownerEmails().has(email) && !as;
  const previewName = viewer?.previewOf?.display_name ?? null;
  const isPreview = viewer?.previewOf != null;

  if (!viewer) {
    return (
      <div className="kf-invoices-surface">
        <IdentBand eyebrow="Invoices" title="We cannot find you on the roster" kick="Ask the office to check your record." />
        <NoRosterRow />
      </div>
    );
  }

  const admin = await isInvoiceAdmin(sb, viewer.worker_id);
  const sites = await loadInvoiceSites(sb);
  const scope = resolveInvoiceScope(
    {
      is_owner: isOwnerNotPreviewing,
      is_invoice_admin: admin,
      is_regional_director: viewer.is_regional_director,
      is_corp: viewer.is_corp,
      is_salaried: viewer.is_salaried,
      region: viewer.region,
      account_key: viewer.account_key ?? null,
    },
    sites,
  );

  if (scope.accountKeys.length === 0) {
    return (
      <div className="kf-invoices-surface">
        {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices" /> : null}
        <IdentBand eyebrow="Invoices" title="No invoices for you yet" kick="Ask the office if you should see them." />
        <NoAccess />
      </div>
    );
  }

  const nav = sitesInScope(scope, sites);
  const many = isManySites(scope);

  const ownerEmail = (viewer.work_email ?? "").trim().toLowerCase();

  if (!site) {
    if (nav.length === 1) {
      const only = nav[0];
      const qs = as ? `&as=${encodeURIComponent(as)}` : "";
      redirect(`/invoices?site=${only.slug}${qs}`);
    }
    // "Which site?" is a cheap read - no Suspense needed; draft
    // counts are a single head query per site.
    const draftCountsBySlug: Record<string, number> = {};
    await Promise.all(nav.map(async (s) => {
      const q = await sb
        .from("invoice_drafts")
        .select("id", { count: "exact", head: true })
        .eq("owner_email", ownerEmail)
        .eq("account_key", s.accountKey)
        .eq("status", "draft");
      draftCountsBySlug[s.slug] = q.count ?? 0;
    }));
    return (
      <WhichSiteChooser
        sites={nav}
        draftCountsBySlug={draftCountsBySlug}
        scope={scope}
        asParam={as}
        previewName={previewName}
      />
    );
  }

  const accountKey = slugToAccountKey(site, scope.accountKeys);
  if (!accountKey) notFound();

  const asParam = as;
  const slug = accountKeyToSlug(accountKey);
  const navSite = nav.find((s) => s.accountKey === accountKey);
  const siteName = navSite?.name ?? accountKey;

  const shared: Shared = {
    scope, nav, manySites: many, slug, accountKey, ownerEmail,
    asParam, previewName, isPreview, siteName,
  };

  // Train 2b fix-before-push #6 / F4: one Suspense boundary per
  // branch. Each branch's skeleton replaces what React is about
  // to stream for that branch; no cross-skeleton flash.
  if (draftId) {
    return (
      <Suspense fallback={<SittingSkeleton />}>
        <SittingSurface shared={shared} draftId={draftId} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<LandingSkeleton />}>
      <LandingSurface shared={shared} />
    </Suspense>
  );
}

async function SittingSurface({ shared, draftId }: { shared: Shared; draftId: string }) {
  const sb = serviceClient();
  const { ownerEmail, accountKey, slug, asParam, siteName, previewName, isPreview } = shared;

  const draft = await getDraftById(sb, ownerEmail, draftId);
  if (!draft) notFound();
  if (draft.account_key !== accountKey) notFound();
  if (draft.status === "discarded") {
    redirect(`/invoices?site=${slug}${asParam ? `&as=${encodeURIComponent(asParam)}` : ""}`);
  }
  // Train 3 §7: a sent draft's old address goes to the invoice.
  if (draft.status === "sent" && draft.submission_id) {
    const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";
    redirect(`/invoices/${draft.submission_id}${asQ}`);
  }

  const [files, codes, vendorRow, fixedOrder] = await Promise.all([
    listFilesForDraft(sb, ownerEmail, draft.id),
    loadActiveCodesForSite(sb, accountKey),
    draft.vendor_id
      ? sb.from("vendors").select("name").eq("id", draft.vendor_id).maybeSingle()
      : Promise.resolve({ data: null, error: null } as { data: { name: string } | null; error: null }),
    listDraftsForOwnerSiteFixedOrder(sb, ownerEmail, accountKey),
  ]);
  const vendorName = (vendorRow.data as { name: string } | null)?.name ?? null;
  const liveFiles = files.filter((f) => f.removed_at == null);
  const activeSet = new Set(codes.map((c) => c.code));
  const usual = draft.vendor_id
    ? await loadUsualCodes(sb, accountKey, draft.vendor_id, activeSet)
    : { codes: [], singleCodeFill: null, sampleSize: 0 };

  const totalInSitting = fixedOrder.length;
  const idx = Math.max(0, fixedOrder.findIndex((d) => d.id === draft.id));
  const prevDraftId = idx > 0 ? fixedOrder[idx - 1].id : null;
  const nextDraftId = idx >= 0 && idx < totalInSitting - 1 ? fixedOrder[idx + 1].id : null;

  return (
    <CaptureSittingRoot
      key={draft.id}
      initialDraft={toDraftView(draft)}
      initialFiles={liveFiles.map(toFileView)}
      initialVendorName={vendorName}
      activeCodes={codes}
      initialUsual={usual}
      siteSlug={slug}
      siteAccountKey={accountKey}
      siteName={siteName}
      asParam={asParam}
      previewName={previewName}
      isPreview={isPreview}
      pager={{
        position: idx + 1,
        total: totalInSitting,
        prevDraftId,
        nextDraftId,
      }}
    />
  );
}

async function LandingSurface({ shared }: { shared: Shared }) {
  const sb = serviceClient();
  const { scope, nav, manySites, ownerEmail, accountKey, slug, asParam, siteName, previewName } = shared;

  const activeCodes = await loadActiveCodesForSite(sb, accountKey);
  const activeCodesSet = new Set(activeCodes.map((c) => c.code));
  const [drafts, latestSent, needsFix, returnedForSite] = await Promise.all([
    listDraftsForOwnerSite(sb, ownerEmail, accountKey),
    loadLatestSent(sb, accountKey, 5),
    sb.from("invoice_submissions").select("*", { count: "exact", head: true })
      .eq("account_key", accountKey).eq("status", "returned"),
    loadReturnedForSite(sb, accountKey, 4),
  ]);
  const fixCount = needsFix.count ?? 0;
  const draftList = await buildDraftListView(sb, ownerEmail, drafts, activeCodesSet);

  // Train 3 §7 "You are set" sent variant: only when switch is
  // on AND there are no drafts. The "N ready" form (train 2b)
  // stays when the switch is off, read inside CaptureLanding.
  const switchMode = outboundMode();
  const recentlySent = (switchMode !== "off" && draftList.length === 0)
    ? await loadRecentlySent(sb, ownerEmail, accountKey, 12)
    : [];

  return (
    <CaptureLanding
      scope={scope}
      sites={nav}
      siteSlug={slug}
      siteAccountKey={accountKey}
      siteName={siteName}
      drafts={draftList}
      latestSent={latestSent}
      needsFixCount={fixCount}
      needsFixPreview={returnedForSite}
      asParam={asParam}
      previewName={previewName}
      manySites={manySites}
      recentlySent={recentlySent}
    />
  );
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
