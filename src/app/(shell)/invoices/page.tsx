// /invoices - Capture. Replaces train 1's redirect (the list stays
// at /invoices/list).
//
// No `site`: one-site viewer -> redirect to their site; many-site
// viewer -> "Which site?". No sites -> NoAccess.
// With `site`, no `draft`: the landing (drop zone + Latest sent +
// Drafts waiting).
// With `site` and `draft`: the sitting (one invoice, page beside
// the fields).
//
// Train 2b correction 4.5: no signed storage URL is built here or
// passed to any client component. The browser asks the view route
// for a 60s link only for the file it is drawing (and again if the
// link expires).

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
  listDraftsForOwnerSite, toDraftView,
  getDraftById, listFilesForDraft, toFileView,
} from "@/lib/invoices/draftLoad";
import { buildDraftListView } from "@/lib/invoices/draftListView";
import { loadLatestSent, loadReturnedForSite } from "@/lib/invoices/latestSent";
import { loadActiveCodesForSite, loadUsualCodes } from "@/lib/invoices/glCodes";
import { CaptureLanding } from "@/components/invoices/CaptureLanding";
import { WhichSiteChooser } from "@/components/invoices/WhichSiteChooser";
import { CaptureSittingRoot } from "@/components/invoices/CaptureSittingRoot";
import { OwnerPreviewBanner } from "@/components/invoices/OwnerPreviewBanner";
import { NoAccess, NoRosterRow } from "@/components/invoices/EmptyStates";
import { IdentBand } from "@/components/ui/IdentBand";
import "@/components/invoices/invoices.css";
import "@/components/invoices/capture.css";

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

  const ownerEmailLower = (viewer.work_email ?? "").trim().toLowerCase();

  if (!site) {
    if (nav.length === 1) {
      const only = nav[0];
      const qs = as ? `&as=${encodeURIComponent(as)}` : "";
      redirect(`/invoices?site=${only.slug}${qs}`);
    }
    // Per-site draft counts for A3 ("2 drafts" under the site row).
    const draftCountsBySlug: Record<string, number> = {};
    await Promise.all(nav.map(async (s) => {
      const q = await sb
        .from("invoice_drafts")
        .select("id", { count: "exact", head: true })
        .eq("owner_email", ownerEmailLower)
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
  const ownerEmail = ownerEmailLower;
  const navSite = nav.find((s) => s.accountKey === accountKey);
  const siteName = navSite?.name ?? accountKey;

  // Sitting
  if (draftId) {
    const draft = await getDraftById(sb, ownerEmail, draftId);
    if (!draft) notFound();
    if (draft.account_key !== accountKey) notFound();
    if (draft.status === "discarded") {
      redirect(`/invoices?site=${slug}${asParam ? `&as=${encodeURIComponent(asParam)}` : ""}`);
    }

    const [files, codes, vendorRow] = await Promise.all([
      listFilesForDraft(sb, ownerEmail, draft.id),
      loadActiveCodesForSite(sb, accountKey),
      draft.vendor_id
        ? sb.from("vendors").select("name").eq("id", draft.vendor_id).maybeSingle()
        : Promise.resolve({ data: null, error: null } as { data: { name: string } | null; error: null }),
    ]);
    const vendorName = (vendorRow.data as { name: string } | null)?.name ?? null;
    const liveFiles = files.filter((f) => f.removed_at == null);

    // Train 2b correction 4.5: no signed URLs in server-rendered HTML.
    // The sitting fetches a 60s link per file on screen via /view.
    const activeSet = new Set(codes.map((c) => c.code));
    const usual = draft.vendor_id
      ? await loadUsualCodes(sb, accountKey, draft.vendor_id, activeSet)
      : { codes: [], singleCodeFill: null, sampleSize: 0 };

    return (
      <CaptureSittingRoot
        initialDraft={toDraftView(draft)}
        initialFiles={liveFiles.map(toFileView)}
        initialVendorName={vendorName}
        activeCodes={codes}
        initialUsual={usual}
        siteSlug={slug}
        siteAccountKey={accountKey}
        asParam={asParam}
        previewName={previewName}
        isPreview={isPreview}
      />
    );
  }

  // Landing
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

  // Train 2b correction 6: server-computed Ready + vendor name per
  // draft. B1 headline, B6 rows and E all read these fields; no
  // client-side copy of the Ready rule.
  const draftList = await buildDraftListView(sb, ownerEmail, drafts, activeCodesSet);

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
      manySites={many}
    />
  );
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
