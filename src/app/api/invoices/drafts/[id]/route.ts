// /api/invoices/drafts/[id]
//   PATCH - partial update with If-Match (optimistic concurrency).
//
// Correction 8: saves from one tab are queued one-in-flight at a
// time on the client; here we only verify the header matches the
// exact updated_at string the DB returned.
//
// Correction 5: no browser-supplied paths touch this route. The
// body is draft fields only.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, toDraftView } from "@/lib/invoices/draftLoad";
import { patchDraft, type DraftPatch } from "@/lib/invoices/draftWrite";
import type { InvoiceKind, DraftScreen, GlLineDraft, DraftAnswers } from "@/lib/invoices/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function toKind(v: unknown): InvoiceKind | undefined {
  if (v === "invoice" || v === "credit") return v;
  return undefined;
}

function toScreen(v: unknown): DraftScreen | null | undefined {
  if (v === "desk" || v === "phone") return v;
  if (v === null) return null;
  return undefined;
}

function toGl(v: unknown): GlLineDraft[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: GlLineDraft[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") return undefined;
    const r = row as { code?: unknown; name?: unknown; amount?: unknown };
    if (typeof r.code !== "string" || typeof r.name !== "string") return undefined;
    const amt = typeof r.amount === "number" ? r.amount : Number(r.amount);
    if (!Number.isFinite(amt)) return undefined;
    out.push({ code: r.code, name: r.name, amount: Math.round(amt * 100) / 100 });
  }
  return out;
}

function toAnswers(v: unknown): DraftAnswers | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: DraftAnswers = {};
  const r = v as Record<string, unknown>;
  if (r.date_confirmed_at_more_than_60_days === true) out.date_confirmed_at_more_than_60_days = true;
  if (r.is_different_invoice === true) out.is_different_invoice = true;
  if (typeof r.is_credit_for === "string") out.is_credit_for = r.is_credit_for;
  return out;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  if (!isUuid(draftId)) return new Response(null, { status: 400 });

  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  const ifMatch = req.headers.get("if-match") ?? "";
  if (!ifMatch) return NextResponse.json({ error: "if_match_required" }, { status: 428 });

  const open = await openInvoiceApi({ as, write: true });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, draftId);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) return new Response(null, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return new Response(null, { status: 400 });

  const patch: DraftPatch = {};
  if ("vendor_id"      in body) patch.vendor_id      = body.vendor_id === null ? null : (typeof body.vendor_id === "string" ? body.vendor_id : undefined);
  if ("type"           in body) {
    const t = toKind(body.type);
    if (t) patch.type = t;
  }
  if ("invoice_number" in body) patch.invoice_number = body.invoice_number === null ? null : (typeof body.invoice_number === "string" ? body.invoice_number : undefined);
  if ("invoice_date"   in body) patch.invoice_date   = body.invoice_date === null ? null : (typeof body.invoice_date === "string" ? body.invoice_date : undefined);
  if ("total_amount"   in body) {
    const t = body.total_amount;
    if (t === null) patch.total_amount = null;
    else if (typeof t === "number" && Number.isFinite(t) && t >= 0) patch.total_amount = Math.round(t * 100) / 100;
  }
  if ("gl_breakdown"   in body) {
    const g = toGl(body.gl_breakdown);
    if (g) patch.gl_breakdown = g;
  }
  if ("answers"        in body) {
    const a = toAnswers(body.answers);
    if (a) patch.answers = a;
  }
  if ("screen"         in body) {
    const s = toScreen(body.screen);
    if (s !== undefined) patch.screen = s;
  }

  const result = await patchDraft(sb, ownerEmail, draftId, ifMatch, patch);
  if (result.status === "not_found") return new Response(null, { status: 404 });
  if (result.status === "frozen")    return NextResponse.json({ error: "frozen" }, { status: 409 });
  if (result.status === "conflict")  return NextResponse.json({ error: "conflict" }, { status: 409 });
  return NextResponse.json({ draft: toDraftView(result.row) });
}
