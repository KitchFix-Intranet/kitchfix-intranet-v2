// /api/invoices/drafts/[id]/check
//   POST - run the Ready check. No DB write (train 2 never sets
//   status='sent'); the client uses the returned shape to label the
//   draft Ready in memory and flip the cursor to the next draft.

import { NextResponse } from "next/server";
import { openInvoiceApi } from "@/lib/invoices/apiGuard";
import { getDraftById, listFilesForDraft } from "@/lib/invoices/draftLoad";
import { runReadyCheck } from "@/lib/invoices/readyCheck";
import { activeCodesSetForSite } from "@/lib/invoices/glCodes";
import { vendorIsAvailable } from "@/lib/invoices/vendorPicker";
import { copyCheck } from "@/lib/invoices/duplicateCheck";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  const url = new URL(req.url);
  const as = url.searchParams.get("as");
  // The check route is read-only in terms of DB writes, but it only
  // makes sense for the owner of the draft; run with write:false so
  // owner preview can still exercise it.
  const open = await openInvoiceApi({ as, write: false });
  if (!open.ok) return open.response;
  const { sb, scope, ownerEmail } = open;

  const draft = await getDraftById(sb, ownerEmail, draftId);
  if (!draft) return new Response(null, { status: 404 });
  if (!scope.accountKeys.includes(draft.account_key)) return new Response(null, { status: 404 });

  const [files, codeSet, vendorOk, copyErr] = await Promise.all([
    listFilesForDraft(sb, ownerEmail, draftId),
    activeCodesSetForSite(sb, draft.account_key),
    draft.vendor_id ? vendorIsAvailable(sb, draft.vendor_id) : Promise.resolve(false),
    copyCheck(sb, ownerEmail, draft),
  ]);

  const result = runReadyCheck({
    draft,
    files,
    activeCodesForSite: codeSet,
    vendorInScope: vendorOk,
    copyError: copyErr,
  });
  return NextResponse.json(result);
}
