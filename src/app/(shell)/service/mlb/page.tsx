// /service/mlb - the big-league clubhouse calendar. Read-only.
// Owner-only today (requireOwnerPage), same three-path visibility as
// /service.
//
// Address: /service/mlb?site=<slug>&m=<0..11>&as=<worker_id>

import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { slugToAccountKey } from "@/lib/sc/calendar/slug";
import { loadMlbCalendar } from "@/lib/sc/mlb/load";
import type { AccountLite, ViewerLite } from "@/lib/sc/calendar/types";
import { BigLeagueCalendar } from "@/components/service/mlb/BigLeagueCalendar";
import { OwnerPreviewBanner } from "@/components/service/OwnerPreviewBanner";
import "../service.css";
import "./mlb.css";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ site?: string | string[]; m?: string | string[]; as?: string | string[] }>;
}) {
  const { email: ownerEmail } = await requireOwnerPage();
  const sp = await searchParams;
  const site = pickOne(sp.site);
  const mRaw = pickOne(sp.m);
  const asWorkerId = pickOne(sp.as);
  if (!site) notFound();

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, ownerEmail, asWorkerId, true);
  if (!viewer) notFound();

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

  // Load active MLB accounts and apply the three-path visibility
  // same as /service's visibleBigLeague.
  const accQ = await sb.from("accounts")
    .select("team_key, name, region, level, timezone, active")
    .eq("active", true)
    .eq("level", "MLB")
    .order("team_key");
  if (accQ.error) notFound();
  const all = (accQ.data ?? []) as AccountLite[];
  const inScope = all.filter((a) => {
    if (viewerLite.is_regional_director) return a.region === viewerLite.region;
    if (viewerLite.is_corp) return true;
    if (viewerLite.is_salaried) return a.team_key === viewerLite.account_key;
    return false;
  });

  const accountKey = slugToAccountKey(site, inScope.map((a) => a.team_key));
  if (!accountKey) notFound();
  const account = inScope.find((a) => a.team_key === accountKey);
  if (!account) notFound();

  const monthParam = mRaw != null ? Number(mRaw) : null;
  const monthValid = monthParam != null && Number.isInteger(monthParam) && monthParam >= 0 && monthParam <= 11;

  const view = await loadMlbCalendar({
    sb,
    account,
    monthParam: monthValid ? monthParam : null,
    basePath: "/service/mlb",
  });

  const previewName = viewer.previewOf?.display_name ?? null;
  const exitHref = `/service/mlb?site=${view.site.slug}`;

  return (
    <>
      {previewName ? (
        <div className="kf-sc-surface">
          <OwnerPreviewBanner name={previewName} exitHref={exitHref} />
        </div>
      ) : null}
      <BigLeagueCalendar view={view} />
    </>
  );
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
