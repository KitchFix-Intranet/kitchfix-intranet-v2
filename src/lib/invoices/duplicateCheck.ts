// Copy check for Capture. Server.
//
// §6: same site + same vendor + same number + same kind as either
//   - an invoice that counts (a submitted row, §5 filter), or
//   - another of this person's live drafts.
// A credit carrying an invoice's number is NOT a copy (different
// kind). Answers can override via `is_different_invoice` or
// `is_credit_for`.
//
// Invoice number is compared the way the database does: via
// `invoice_number_normalized` (§correction 9). We compute the same
// shape for the draft side.
//
// Train 2b correction 4: the check returns the MATCHED row's
// client-safe fields (vendor name, number, date), not a boolean.
// C9's stop block uses them to show "You already sent this one -
// Acme #1234 on 11/02/2026" without the client having to look the
// row up itself. `same_draft` returns just number and vendor (no
// invoice_date; a draft's date may be null or garbage). No email,
// no total, no who sent it.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftRow, InvoiceKind, CopyMatchView } from "./types";
import { normalizeInvoiceNumber } from "./invNumber";
import { loadVendorNames } from "./draftLoad";

export type CopyErrorKind = "same_invoice" | "same_draft";

// A client-safe snapshot of the matched row.
export type CopyMatch = CopyMatchView;

// The server-side result shape used by the check route.
export interface CopyCheckResult {
  kind: CopyErrorKind;
  match: CopyMatch;
}

// Pure predicate: given the draft and a candidate (a counting
// submission or another live draft), is the candidate a copy?
// Rules:
//   - same site AND same vendor AND same kind AND normalized number equal
//   - a credit is NOT a copy of an invoice with the same number
//   - a draft answering `is_different_invoice` or `is_credit_for`
//     accepts the pairing and is never a copy
//   - comparing a draft against itself is not a copy (caller must
//     skip self; we also check id if provided)
export interface CopyCandidate {
  id?: string;
  account_key: string;
  vendor_id: string | null;
  type: InvoiceKind;
  invoice_number: string | null;
}

export function isCopyCandidate(
  draft: Pick<DraftRow, "id" | "account_key" | "vendor_id" | "type" | "invoice_number" | "answers">,
  candidate: CopyCandidate,
): boolean {
  if (candidate.id && candidate.id === draft.id) return false;
  if (draft.answers?.is_different_invoice) return false;
  if (draft.answers?.is_credit_for) return false;
  if (!draft.vendor_id || !candidate.vendor_id) return false;
  if (draft.account_key !== candidate.account_key) return false;
  if (draft.vendor_id !== candidate.vendor_id) return false;
  if (draft.type !== candidate.type) return false;
  const a = normalizeInvoiceNumber(draft.invoice_number);
  const b = normalizeInvoiceNumber(candidate.invoice_number);
  if (!a || !b) return false;
  return a === b;
}

// Returns the first collision (kind + matched row's client-safe
// fields), or null. The UI's "ways out" (remove / different /
// credit) live on the client; this function only names the match.
export async function copyCheck(
  sb: SupabaseClient,
  ownerEmail: string,
  draft: DraftRow,
): Promise<CopyCheckResult | null> {
  const num = normalizeInvoiceNumber(draft.invoice_number);
  if (!num) return null;
  if (!draft.vendor_id) return null;

  // Answers can override. Train 3 may tighten these; train 2 just
  // respects the flags §6 names.
  if (draft.answers?.is_different_invoice) return null;
  // If the draft is marked as the credit-for a specific submission,
  // the user has accepted the pairing; not a copy.
  if (draft.answers?.is_credit_for) return null;

  // 1. Against counting invoice_submissions. Same site, vendor, kind;
  //    normalized number matches via invoice_number_normalized.
  const subQ = await sb
    .from("invoice_submissions")
    .select("id, vendor_id, invoice_number, invoice_date")
    .eq("account_key", draft.account_key)
    .eq("vendor_id", draft.vendor_id)
    .eq("type", draft.type)
    .eq("invoice_number_normalized", num)
    .not("status", "in", "(deleted,corrected,archived)")
    .limit(1);
  if (!subQ.error && (subQ.data ?? []).length > 0) {
    const row = (subQ.data ?? [])[0] as { id: string; vendor_id: string; invoice_number: string; invoice_date: string | null };
    const names = await loadVendorNames(sb, [row.vendor_id]);
    return {
      kind: "same_invoice",
      match: {
        kind: "same_invoice",
        vendor_name: names.get(row.vendor_id) ?? null,
        invoice_number: row.invoice_number,
        invoice_date: row.invoice_date,
        submission_id: row.id,
      },
    };
  }

  // 2. Against this person's OTHER live drafts (not this one).
  // Train 3 ride 8.1: a twin that has already answered "It is a
  // different invoice" settles the pair. `answers` is included
  // in the select so the loop can skip twins whose answer is set.
  const draftQ = await sb
    .from("invoice_drafts")
    .select("id, vendor_id, invoice_number, invoice_date, answers")
    .eq("owner_email", ownerEmail)
    .eq("account_key", draft.account_key)
    .eq("vendor_id", draft.vendor_id)
    .eq("type", draft.type)
    .eq("status", "draft")
    .neq("id", draft.id)
    .limit(50);
  if (!draftQ.error) {
    for (const row of (draftQ.data ?? []) as Array<{ id: string; vendor_id: string; invoice_number: string | null; invoice_date: string | null; answers: { is_different_invoice?: unknown } | null }>) {
      if (normalizeInvoiceNumber(row.invoice_number) === num) {
        // Either side's answer settles the pair.
        if (row.answers?.is_different_invoice === true) continue;
        const names = await loadVendorNames(sb, [row.vendor_id]);
        return {
          kind: "same_draft",
          match: {
            kind: "same_draft",
            vendor_name: names.get(row.vendor_id) ?? null,
            invoice_number: row.invoice_number,
            // A draft's date may not yet be a real date; the C9 block
            // on same_draft deliberately does not show it.
            invoice_date: null,
            submission_id: null,
          },
        };
      }
    }
  }

  return null;
}
