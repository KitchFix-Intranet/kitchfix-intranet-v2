// /invoices/list - the list surface. Owner-only. Read-only.
//
// Address params:
//   site   slug of one site in scope (filter + drawer anchor)
//   show   all | fix | acct (fallback 'all' on bad value)
//   q      case-insensitive text search over vendor_name OR invoice_number
//   inv    id of the invoice open in the drawer
//   more   how many 50-row pages are loaded (fallback 1, clamped >= 1)
//   as     worker_id for owner preview
//
// Scope and gate run on the server before any row leaves the loader.

import { notFound } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { ownerEmails } from "@/lib/supabase/env";
import { currentPeriod } from "@/lib/fiscalPeriod";
import { isInvoiceAdmin, loadInvoiceList, loadInvoiceDetail } from "@/lib/invoices/load";
import { loadInvoiceSites } from "@/lib/invoices/accessList";
import { resolveInvoiceScope, sitesInScope, isManySites } from "@/lib/invoices/scope";
import { slugToAccountKey } from "@/lib/invoices/slug";
import type { FilterKey } from "@/lib/invoices/types";
import { InvoicesSurface } from "@/components/invoices/InvoicesSurface";
import { NoAccess, NoRosterRow } from "@/components/invoices/EmptyStates";
import { IdentBand } from "@/components/ui/IdentBand";
import { OwnerPreviewBanner } from "@/components/invoices/OwnerPreviewBanner";
import "@/components/invoices/invoices.css";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    site?: string | string[];
    show?: string | string[];
    q?: string | string[];
    inv?: string | string[];
    more?: string | string[];
    as?: string | string[];
  }>;
}) {
  const { email } = await requireOwnerPage();
  const sp = await searchParams;
  const site = pickOne(sp.site);
  const show = parseShow(pickOne(sp.show));
  const q = normaliseQ(pickOne(sp.q));
  const inv = pickOne(sp.inv);
  const more = Math.max(1, Number(pickOne(sp.more) || "1") || 1);
  const as = pickOne(sp.as);

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, email, as, true);
  const isOwnerNotPreviewing = ownerEmails().has(email) && !as;
  const previewName = viewer?.previewOf?.display_name ?? null;

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
        {previewName ? <OwnerPreviewBanner name={previewName} exitHref="/invoices/list" /> : null}
        <IdentBand eyebrow="Invoices" title="No invoices for you yet" kick="Ask the office if you should see them." />
        <NoAccess />
      </div>
    );
  }

  const inScopeNav = sitesInScope(scope, sites);
  const inScopeKeys = inScopeNav.map((s) => s.accountKey);
  const manySites = isManySites(scope);

  // Resolve the ?site= to an accountKey inside scope. A slug outside
  // scope -> notFound(). Null site is allowed (all-sites view).
  let resolvedSite: string | null = null;
  if (site) {
    const key = slugToAccountKey(site, inScopeKeys);
    if (!key) notFound();
    resolvedSite = key;
  }

  const listView = await loadInvoiceList({
    sb, scope, site: resolvedSite, show, q, more,
  });

  // Drawer detail (one query budget). If `inv` is set but the row is
  // out of scope / deleted / unknown, we drop the drawer and leave
  // the list as-is (per §3 "A bad or out-of-scope `inv` shows the
  // list with no drawer").
  let invDetail = null;
  if (inv) {
    invDetail = await loadInvoiceDetail(sb, scope, inv);
    // Scope on /invoices/[id] is handled by its own route; this is
    // the belt-and-suspenders check for the ?inv= case. Unknown id
    // or out-of-scope returns null and we render the list without
    // the drawer.
  }

  const period = await currentPeriod();

  return (
    <InvoicesSurface
      viewer={viewer}
      scope={scope}
      sites={inScopeNav}
      site={resolvedSite}
      show={show}
      q={q}
      inv={inv}
      more={more}
      asParam={as}
      previewName={previewName}
      listView={listView}
      invDetail={invDetail}
      period={period}
      manySites={manySites}
    />
  );
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

function parseShow(v: string | null): FilterKey {
  if (v === "fix" || v === "acct" || v === "all") return v;
  return "all"; // §3: bad `show` falls back to `all`
}

function normaliseQ(v: string | null): string | null {
  if (!v) return null;
  // Trim, then cap at 80 chars so a pasted paragraph cannot
  // widen the scoped ilike into a cartesian hunt.
  const trimmed = v.trim().slice(0, 80);
  return trimmed.length > 0 ? trimmed : null;
}
