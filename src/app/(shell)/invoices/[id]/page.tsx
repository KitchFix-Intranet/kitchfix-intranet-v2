// /invoices/[id] - the deep-link address. Train 1 resolves the id
// to its site inside the viewer's scope, then redirects to the list
// with ?inv=<id> to open the drawer. Out-of-scope or unknown id:
// notFound(). KPI will link here.

import { notFound, redirect } from "next/navigation";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { isInvoiceAdmin } from "@/lib/invoices/load";
import { loadInvoiceSites } from "@/lib/invoices/accessList";
import { resolveInvoiceScope } from "@/lib/invoices/scope";
import { accountKeyToSlug } from "@/lib/invoices/slug";
import { ownerEmails } from "@/lib/supabase/env";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ as?: string | string[] }>;
}) {
  const { email } = await requireOwnerPage();
  const { id } = await params;
  const sp = await searchParams;
  const as = pickOne(sp.as);

  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, email, as, true);
  if (!viewer) notFound();

  const isOwner = ownerEmails().has(email) && !as;
  const admin = await isInvoiceAdmin(sb, viewer.worker_id);
  const sites = await loadInvoiceSites(sb);
  const scope = resolveInvoiceScope(
    {
      is_owner: isOwner,
      is_invoice_admin: admin,
      is_regional_director: viewer.is_regional_director,
      is_corp: viewer.is_corp,
      is_salaried: viewer.is_salaried,
      region: viewer.region,
      account_key: viewer.account_key ?? null,
    },
    sites,
  );
  if (scope.accountKeys.length === 0) notFound();

  // Read only account_key for the scope check - no other column
  // leaves the server from this route.
  const row = await sb
    .from("invoice_submissions")
    .select("account_key, status")
    .eq("id", id)
    .maybeSingle();
  if (row.error || !row.data) notFound();
  const accountKey = (row.data as { account_key: string }).account_key;
  const status = (row.data as { status: string }).status;
  if (status === "deleted" || status === "corrected" || status === "archived") notFound();
  if (!scope.accountKeys.includes(accountKey)) notFound();

  const slug = accountKeyToSlug(accountKey);
  const asQ = as ? `&as=${encodeURIComponent(as)}` : "";
  redirect(`/invoices/list?site=${slug}&inv=${encodeURIComponent(id)}${asQ}`);
}

function pickOne(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
