// /api/invoices/drafts
//   POST - create a draft at the browser-provided id.
//   GET  - list this viewer's live drafts for a site.
//
// Idempotency (correction 3): the browser generates the draft id
// (a uuid) and sends it. A repeat with the same id returns the
// existing row if the owner matches, 404 if not. Never upsert.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { createDraft } from "@/lib/invoices/draftWrite";
import { listDraftsForOwnerSite, toDraftView } from "@/lib/invoices/draftLoad";
import type { DraftScreen } from "@/lib/invoices/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CreateBody {
  id?: string;
  site?: string;              // slug or team_key
  screen?: DraftScreen;
}

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const body = (await req.json().catch(() => null)) as CreateBody | null;
  if (!body || !isUuid(body.id) || !body.site) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const screen: DraftScreen = body.screen === "phone" ? "phone" : "desk";
  const open = await openInvoiceApi({ as, write: true, site: { slugOrKey: body.site, required: true } });
  if (!open.ok) return open.response;
  const { sb, viewer, ownerEmail, accountKey } = open;
  if (!accountKey) return new Response(null, { status: 400 });

  const result = await createDraft(sb, {
    id: body.id,
    ownerEmail,
    ownerWorkerId: viewer.worker_id ?? null,
    accountKey,
    screen,
  });
  if (result.status === "not_mine") return new Response(null, { status: 404 });
  if (!result.row) return NextResponse.json({ error: "create_failed" }, { status: 500 });
  return NextResponse.json({ draft: toDraftView(result.row) }, { status: result.status === "created" ? 201 : 200 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const site = url.searchParams.get("site");
  if (!site) return NextResponse.json({ drafts: [] });
  // Owner preview is read-only but not blocked (write:false).
  const open = await openInvoiceApi({ as, write: false, site: { slugOrKey: site, required: true } });
  if (!open.ok) return open.response;
  const { sb, ownerEmail, accountKey } = open;
  if (!accountKey) return NextResponse.json({ drafts: [] });
  const rows = await listDraftsForOwnerSite(sb, ownerEmail, accountKey);
  return NextResponse.json({ drafts: rows.map(toDraftView) });
}
