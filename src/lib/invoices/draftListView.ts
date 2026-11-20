// Build DraftListView[] for the landing's B6 (Drafts waiting) and
// for B1's headline count. Server-only.
//
// Train 2b correction 6: Ready is worked out on the server using
// `runReadyCheck`, the same rule the Check-and-send path uses. No
// client-side copy of the rule exists. The landing calls this once
// per request, passing the already-loaded code set (one query per
// page, not per draft).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftRow, DraftListView } from "./types";
import { toDraftView, listFilesForDraft, loadVendorNames } from "./draftLoad";
import { runReadyCheck } from "./readyCheck";
import { copyCheck } from "./duplicateCheck";
import { vendorIsAvailable } from "./vendorPicker";

// Short, plain-words missing-field list from CheckError messages.
// Capped to 4 so the row doesn't wrap into a paragraph.
function toMissing(errors: ReadonlyArray<{ field: string; message: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errors) {
    const label = labelFor(e.field);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length === 4) break;
  }
  return out;
}

function labelFor(field: string): string {
  switch (field) {
    case "vendor_id": return "Vendor";
    case "type": return "Kind";
    case "invoice_number": return "Number";
    case "invoice_date": return "Date";
    case "date_more_than_60": return "Date";
    case "total_amount": return "Total";
    case "gl_breakdown": return "Coding";
    case "files": return "Page";
    case "copy": return "Copy";
    default: return "Something";
  }
}

export async function buildDraftListView(
  sb: SupabaseClient,
  ownerEmail: string,
  drafts: readonly DraftRow[],
  codeSet: ReadonlySet<string>,
): Promise<DraftListView[]> {
  if (drafts.length === 0) return [];

  // Vendor names in one query.
  const vendorIds = drafts.map((d) => d.vendor_id).filter((v): v is string => typeof v === "string");
  const names = await loadVendorNames(sb, vendorIds);

  // Ready check per draft. We batch the per-draft reads but run them
  // in parallel. A landing with a handful of drafts stays fast.
  return Promise.all(drafts.map(async (d) => {
    const [files, vendorOk, copy] = await Promise.all([
      listFilesForDraft(sb, ownerEmail, d.id),
      d.vendor_id ? vendorIsAvailable(sb, d.vendor_id) : Promise.resolve(false),
      copyCheck(sb, ownerEmail, d),
    ]);
    const check = runReadyCheck({
      draft: d,
      files,
      activeCodesForSite: codeSet,
      vendorInScope: vendorOk,
      copyError: copy ? copy.kind : null,
    });
    return {
      ...toDraftView(d),
      vendor_name: d.vendor_id ? (names.get(d.vendor_id) ?? null) : null,
      ready: check.ready,
      missing: check.ready ? [] : toMissing(check.errors),
    };
  }));
}
