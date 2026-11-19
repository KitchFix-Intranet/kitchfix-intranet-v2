// Shared route preamble for the Capture API. Every route under
// /api/invoices/** calls `openInvoiceApi` first:
//
//   1. requireOwnerApi()           - owner-email allowlist (G-B)
//   2. resolveViewer(..., as, true) - signed-in person, honouring ?as=
//   3. scope.accountKeys check      - is this site in the viewer's reach?
//   4. previewOf guard (write only) - under ?as=, writes refuse with 403
//      (correction 4 of the train 2 prompt)
//
// Returns a tagged result. On any gate failure the caller returns the
// `response` verbatim. On success the caller gets a fully built
// `{ sb, viewer, scope, ownerEmail }` and may continue.
//
// The scope list comes from train 1's `resolveInvoiceScope` + the
// invoice-admin flag. The site key arrives either as a slug or an
// accountKey - the handler passes whichever it has.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { ownerEmails } from "@/lib/supabase/env";
import type { Viewer } from "@/lib/people/types";
import { resolveInvoiceScope, type SiteAccount } from "./scope";
import type { InvoiceScope } from "./types";
import { loadInvoiceSites } from "./accessList";
import { isInvoiceAdmin } from "./load";
import { slugToAccountKey } from "./slug";

export interface OpenInvoiceApiArgs {
  as: string | null;
  // "write" routes return 403 under ?as= preview. "read" routes
  // allow preview (owner can see what the person would see).
  write: boolean;
  // Optional: resolve a site slug or team_key to the real accountKey
  // and confirm it is in the viewer's scope. On a miss, return 404.
  site?: { slugOrKey: string | null; required?: boolean };
}

export type OpenInvoiceApiResult =
  | { ok: true; sb: SupabaseClient; viewer: Viewer; scope: InvoiceScope; ownerEmail: string; accountKey: string | null }
  | { ok: false; response: Response };

export async function openInvoiceApi(args: OpenInvoiceApiArgs): Promise<OpenInvoiceApiResult> {
  const gated = await requireOwnerApi();
  if (gated instanceof Response) return { ok: false, response: gated };
  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, gated.email, args.as, true);
  if (!viewer) return { ok: false, response: new Response(null, { status: 404 }) };

  if (args.write && viewer.previewOf !== null) {
    return {
      ok: false,
      response: NextResponse.json({ error: "preview_no_write" }, { status: 403 }),
    };
  }

  const isOwnerNotPreviewing = ownerEmails().has(gated.email) && !args.as;
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

  let accountKey: string | null = null;
  if (args.site?.slugOrKey) {
    const raw = args.site.slugOrKey;
    // Accept either a slug or the raw team_key.
    const inScope = scope.accountKeys;
    accountKey = inScope.includes(raw) ? raw : slugToAccountKey(raw, inScope);
    if (!accountKey) return { ok: false, response: new Response(null, { status: 404 }) };
  } else if (args.site?.required) {
    return { ok: false, response: new Response(null, { status: 400 }) };
  }

  const ownerEmail = (viewer.work_email ?? "").trim().toLowerCase();
  if (!ownerEmail) return { ok: false, response: new Response(null, { status: 400 }) };

  return { ok: true, sb, viewer, scope, ownerEmail, accountKey };
}

// Re-export for type-only use.
export type { InvoiceScope, SiteAccount };
