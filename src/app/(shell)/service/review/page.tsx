// /service/review - the week check screen. Server component.
//
// Address: /service/review?site=<slug>&week=<Monday-ISO>
// Owner-only today (requireOwnerPage). canWriteForAccount runs the
// scope rule server-side before the loader so a signed-in staff
// member is served the right data on the day the switch flips.
//
// The submit POSTs to /api/service/submit-week. On success the
// client plays the finish overlay; on a BLOCKED response the days
// surface the first blocker and Submit stays disabled.

import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { visibleSites, siteInfoFrom } from "@/lib/sc/calendar/accessList";
import { slugToAccountKey } from "@/lib/sc/calendar/slug";
import { canWriteForAccount } from "@/lib/sc/access/canWriteForAccount";
import { loadReviewScreen } from "@/lib/sc/submit/reviewLoader";
import { isSubmitAllowed } from "@/lib/sc/submit/billedOutboundGate";
import type { AccountLite, ViewerLite } from "@/lib/sc/calendar/types";
import { ReviewPage } from "@/components/service/review/ReviewPage";
import "../service.css";
import "./review.css";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ site?: string | string[]; week?: string | string[] }>;
}) {
  const { email: ownerEmail } = await requireOwnerPage();
  const sp = await searchParams;
  const slug = pickOne(sp.site);
  const week = pickOne(sp.week);
  if (!slug || !week) notFound();

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, ownerEmail, null, true);
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

  // Only sites the viewer may read/write.
  const accQ = await sb.from("accounts")
    .select("team_key, name, region, level, timezone, active")
    .eq("active", true);
  if (accQ.error) notFound();
  const accs = (accQ.data ?? []) as AccountLite[];

  const inScope = visibleSites(viewerLite, accs);
  const accountKey = slugToAccountKey(slug, inScope.map((s) => s.accountKey));
  if (!accountKey) notFound();

  const accountRow = accs.find((a) => a.team_key === accountKey);
  if (!accountRow) notFound();

  const can = canWriteForAccount(viewerLite, accountKey);
  if (!can.ok) notFound();

  // Read account_map once for billed + cadence.
  const amQ = await sb.from("sc_qbo_account_map")
    .select("cadence, active")
    .eq("account_key", accountKey)
    .maybeSingle();
  const site = siteInfoFrom(accountRow, (amQ.data as { cadence: "weekly" | "biweekly" | null; active: boolean | null } | null) ?? null);

  const view = await loadReviewScreen(sb, viewerLite, site, week, ownerEmail);

  // Round 3 fix 2: evaluate the outbound-off gate server-side so the
  // page loads with Submit already off + the exact words in view.
  // The route runs this check again on POST; server is the source
  // of truth, this is the look-ahead.
  const outboundGate = isSubmitAllowed(site.isBilled);
  const outboundBlock = outboundGate.allowed ? null : {
    code: outboundGate.code,
    message: outboundGate.message,
  };

  const backHref = `/service?site=${site.slug}`;

  return <ReviewPage view={view} backHref={backHref} outboundBlock={outboundBlock} />;
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
