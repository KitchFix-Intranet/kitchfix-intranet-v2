// Viewer resolution for /people. Server-only.
//
// Seasonal-rehire discipline (same shape as
// `src/lib/academy/identity.ts`, NOT imported - cross-lane):
// 142 of the humans on the roster hold more than one worker_id row
// because seasonal staff are rehired under a new stint each season
// while keeping the same work_email. The join to `people` REQUIRES
// `status = 'ACTIVE'`. Without that filter, a single login resolves
// to multiple rows.
//
// If MORE THAN ONE active row still matches, that is a defect
// (unique-index breach or a leaked non-active row), NOT a fallback:
// this resolver logs the email + worker_ids loudly and returns null
// so the page renders "You are not on the roster yet" rather than
// silently picking one row and leaking the wrong scope. Same rule
// applies to the owner `?as=<worker_id>` override.
//
// PII posture
// ───────────
// This module never SELECTs `personal_email` or `phone`. The
// viewer's identity does not need them, and the roster view
// never shows them. The card loader (loadPerson.ts) is the only
// place personal_email / phone are pulled; the contact rule
// (contact.ts) is the only place they leave the server.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PeopleRow, Viewer } from "./types";
import { buildViewer } from "./scope";

// Narrow projection. personal_email, phone, start_date, birthday
// are DELIBERATELY absent - the viewer layer has no use for them.
const VIEWER_SELECT =
  "worker_id, display_name, title, account_key, region, work_email, manager_worker_id, is_corp, is_salaried, is_site_leader, is_regional_director, pp_full_access, pp_review, status";

function pickSingle(
  rows: PeopleRow[],
  email: string,
  label: "self" | "as",
): PeopleRow | null {
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Defect, not a fallback. Log with the email and the
    // worker_ids so the drift is visible and traceable, then
    // decline. Mirror of academy/identity.ts.
    const workerIds = rows.map((r) => r.worker_id).join(",");
    console.error(
      `[people/viewer] duplicate active people rows for one ${label}: email=${email} worker_ids=${workerIds}`,
    );
    return null;
  }
  return rows[0];
}

export async function resolveViewer(
  sb: SupabaseClient,
  signedInEmail: string,
  asWorkerId: string | null,
  isOwner: boolean,
): Promise<{ viewer: Viewer | null; selfRow: PeopleRow | null }> {
  const email = (signedInEmail || "").toLowerCase().trim();
  if (!email) return { viewer: null, selfRow: null };

  // Step 1. The owner's own row. status='ACTIVE' is load-bearing.
  // We take all matching ACTIVE rows (not .maybeSingle()) so we
  // can detect a duplicate loudly instead of throwing.
  const selfQ = await sb
    .from("people")
    .select(VIEWER_SELECT)
    .eq("status", "ACTIVE")
    .ilike("work_email", email);
  if (selfQ.error) {
    console.error(`[people/viewer] self lookup: ${selfQ.error.message}`);
    return { viewer: null, selfRow: null };
  }
  const selfRow = pickSingle((selfQ.data as PeopleRow[]) ?? [], email, "self");
  if (!selfRow) return { viewer: null, selfRow: null };

  // Step 2. Owner preview: swap the viewer to ?as=<worker_id>
  // when the signed-in viewer is an owner. Same duplicate-row
  // discipline (the ?as= target is matched on worker_id, which
  // is unique, but status='ACTIVE' still applies).
  if (isOwner && asWorkerId) {
    const asQ = await sb
      .from("people")
      .select(VIEWER_SELECT)
      .eq("status", "ACTIVE")
      .eq("worker_id", asWorkerId);
    if (asQ.error) {
      console.error(`[people/viewer] as lookup: ${asQ.error.message}`);
      // Fall through to the real viewer rather than crash.
    } else {
      const asRow = pickSingle((asQ.data as PeopleRow[]) ?? [], `worker_id=${asWorkerId}`, "as");
      if (asRow) {
        return {
          viewer: buildViewer(asRow, {
            worker_id: asRow.worker_id,
            display_name: asRow.display_name ?? "",
          }),
          selfRow,
        };
      }
      // Unknown or inactive ?as= target: drop the param, use the
      // real viewer so the page still loads.
    }
  }

  return { viewer: buildViewer(selfRow, null), selfRow };
}
