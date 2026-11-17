// /service - the calendar home (train 1, read-only). Owner-only.
//
// Address: /service?site=<slug>&fy=<year>&p=<period>&as=<worker_id>
//   - no site: a viewer with one calendar account lands on it; a
//     viewer with several gets the stand-in site list; nobody in
//     scope gets the no-access state.
//   - a site outside the viewer's scope: notFound().
//   - no fy or p: the period that holds the site's own today.

import { notFound, redirect } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { visibleSites, siteInfoFrom } from "@/lib/sc/calendar/accessList";
import { slugToAccountKey } from "@/lib/sc/calendar/slug";
import { loadCalendar } from "@/lib/sc/calendar/load";
import type { AccountLite, ViewerLite } from "@/lib/sc/calendar/types";
import { CalendarPage } from "@/components/service/CalendarPage";
import { SiteList } from "@/components/service/SiteList";
import { NoAccess, NoRosterRow, TwentySeven } from "@/components/service/CalendarEmpty";
import { IdentBand } from "@/components/ui/IdentBand";
import { OwnerPreviewBanner } from "@/components/service/OwnerPreviewBanner";
import "./service.css";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ site?: string | string[]; fy?: string | string[]; p?: string | string[]; as?: string | string[] }>;
}) {
  const { email: ownerEmail } = await requireOwnerPage();
  const sp = await searchParams;
  const site = pickOne(sp.site);
  const fyRaw = pickOne(sp.fy);
  const pRaw = pickOne(sp.p);
  const asWorkerId = pickOne(sp.as);

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, ownerEmail, asWorkerId, /* isOwner */ true);

  if (!viewer) {
    return (
      <div className="kf-sc-surface">
        <IdentBand eyebrow="Service Calendar" title="We cannot find you on the roster" kick="Ask the office to check your record." />
        <NoRosterRow />
      </div>
    );
  }

  const viewerLite: ViewerLite = {
    worker_id: viewer.worker_id,
    display_name: viewer.display_name,
    role: viewer.role,
    is_corp: !!viewer.is_corp,
    is_regional_director: !!viewer.is_regional_director,
    is_salaried: !!viewer.is_salaried,
    region: viewer.region,
    account_key: viewer.account_key,
    previewOf: viewer.previewOf,
  };

  // Calendar accounts: active AND has at least one active service AND
  // level <> 'MLB' (the four big league clubhouses). Selected in one
  // query here because it is the same read for every page.
  const calendarAccounts = await loadCalendarAccounts(sb);

  const inScope = visibleSites(viewerLite, calendarAccounts);
  if (inScope.length === 0) {
    const previewName = viewer.previewOf?.display_name ?? null;
    return (
      <div className="kf-sc-surface">
        {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/service" /> : null}
        <IdentBand eyebrow="Service Calendar" title="No calendar for you yet" kick="Ask the office if you should have one." />
        <NoAccess />
      </div>
    );
  }

  // No site: one-site viewer lands on it; many-site viewer gets the list.
  if (!site) {
    if (inScope.length === 1) {
      const only = inScope[0];
      const qs = asWorkerId ? `&as=${encodeURIComponent(asWorkerId)}` : "";
      redirect(`/service?site=${only.slug}${qs}`);
    }
    const previewName = viewer.previewOf?.display_name ?? null;
    return (
      <div className="kf-sc-surface">
        {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/service" /> : null}
        <IdentBand eyebrow="Service Calendar" title="Your sites" />
        <SiteList sites={inScope} basePath="/service" />
      </div>
    );
  }

  // Resolve the site slug against the viewer's scope.
  const accountKey = slugToAccountKey(site, inScope.map((s) => s.accountKey));
  if (!accountKey) notFound();

  const accountRow = calendarAccounts.find((a) => a.team_key === accountKey);
  if (!accountRow) notFound();

  // Read the account_map once so we know billed + cadence for SiteInfo.
  const amQ = await sb
    .from("sc_qbo_account_map")
    .select("cadence, active")
    .eq("account_key", accountKey)
    .maybeSingle();
  const siteInfo = siteInfoFrom(accountRow, (amQ.data as { cadence: "weekly" | "biweekly" | null; active: boolean | null } | null) ?? null);

  // Parse fy + p.
  const fyParsed = fyRaw ? Number(fyRaw) : null;
  const fy: number = (fyParsed === 2026 || fyParsed === 2027) ? fyParsed : 2026;

  // Fiscal 2027 has no day records yet.
  if (fy === 2027) {
    const previewName = viewer.previewOf?.display_name ?? null;
    const asQ = asWorkerId ? `&as=${encodeURIComponent(asWorkerId)}` : "";
    return (
      <div className="kf-sc-surface">
        {previewName ? <OwnerPreviewBanner name={previewName} exitHref={`/service?site=${siteInfo.slug}`} /> : null}
        <IdentBand eyebrow={siteInfo.name} title="The 2027 calendar is not loaded yet" kick="Fiscal 2027 runs Dec 28, 2026 to Dec 26, 2027." />
        <TwentySeven />
        <div className="kf-sc-yearswitch">
          <a className="kf-btn kf-btn--primary" href={`/service?site=${siteInfo.slug}${asQ}`}>Back to 2026</a>
        </div>
      </div>
    );
  }

  const pParsed = pRaw ? Number(pRaw) : null;
  const periodNo: number | null = (pParsed && pParsed >= 1 && pParsed <= 13) ? pParsed : null;

  const view = await loadCalendar({
    sb,
    viewer: viewerLite,
    site: siteInfo,
    fiscalYear: fy,
    periodNo,
  });

  const previewName = viewer.previewOf?.display_name ?? null;
  const asQ = asWorkerId ? `&as=${encodeURIComponent(asWorkerId)}` : "";

  return (
    <CalendarPage
      view={view}
      basePath="/service"
      asQuery={asQ}
      previewName={previewName}
    />
  );
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

async function loadCalendarAccounts(sb: ReturnType<typeof serviceClient>): Promise<AccountLite[]> {
  // Active accounts, level <> MLB, with at least one active service.
  const accQ = await sb
    .from("accounts")
    .select("team_key, name, region, level, timezone, active")
    .eq("active", true)
    .neq("level", "MLB")
    .order("team_key");
  if (accQ.error) throw new Error(`accounts: ${accQ.error.message}`);
  const accounts = (accQ.data ?? []) as AccountLite[];
  if (accounts.length === 0) return [];

  // Narrow to those with at least one active service.
  const svcQ = await sb
    .from("sc_services")
    .select("account_key")
    .in("account_key", accounts.map((a) => a.team_key))
    .eq("active", true);
  if (svcQ.error) throw new Error(`sc_services activity: ${svcQ.error.message}`);
  const haveActive = new Set((svcQ.data ?? []).map((r) => String((r as { account_key: string }).account_key)));

  return accounts.filter((a) => haveActive.has(a.team_key));
}
