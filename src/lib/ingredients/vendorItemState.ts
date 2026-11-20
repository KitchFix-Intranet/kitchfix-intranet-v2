// T4 §2 ruling 4: one function answers "what state is this item?" so
// every reader - segment chip counts, panel head pills, linkCell labels,
// Vendor items row label, Restore eligibility - agrees on the old shape
// and the new.
//
// Old-shape rows exist because train 4 adds two new `status` values
// that mean what a person meant to say but could not say in the old
// data:
//
//   One-off          old: status='archived', link_status='rejected',
//                         link_reason starts with 'oneoff:' or 'oneoff'
//                    new: status='one_off',  link_status='rejected',
//                         link_reason='oneoff'
//
//   Not food (person)
//                    old: status='active',   link_status='rejected',
//                         link_reason starts with 'notfood:' or 'notfood',
//                         is_food=true (intake did not flag the item)
//                    new: status='not_food', link_status='rejected',
//                         link_reason='notfood', is_food=true
//
// A one-time correction will walk the old rows and flip them into the
// new shape; Chat-Claude writes that correction. Until it runs, the
// old shape still exists. Every reader calls this helper so the UI
// speaks the same word in either case.
//
// The reason-prefix test strips everything after the first colon, so
// an old-shape row carrying `oneoff:kevin@kitchfix.com` and a new-shape
// row carrying `oneoff` BOTH resolve to "one_off". This is how ruling 11
// keeps the email out of the UI without blocking on the correction.

export type VendorItemState =
  | "linked"      // link_status='confirmed', in a live status (active or resale)
  | "retail"      // status='resale' (regardless of link_status)
  | "proposed"    // link_status='proposed', in a live status
  | "one_off"     // new or old shape (see header)
  | "not_food"    // new shape OR person-marked old shape OR intake-flagged (is_food=false)
  | "archived"    // status='archived' and NOT the one-off old shape
  | "duplicate"   // status='duplicate'
  | "not_linked"  // link_status='none', in a live status
  | "rejected";   // link_status='rejected' that is none of the dispositions above

export type VendorItemStateInput = {
  status: string | null | undefined;
  link_status: string | null | undefined;
  link_reason: string | null | undefined;
  is_food: boolean | null | undefined;
};

// The word before the first colon in link_reason, or the whole string
// when no colon. Case-insensitive. Returns "" for null / empty. Used
// to tell `oneoff:kevin@example.com` (old shape) from `oneoff` (new
// shape) without ever letting the tail cross a surface.
export function reasonVerb(raw: string | null | undefined): string {
  if (!raw) return "";
  const i = raw.indexOf(":");
  const head = i < 0 ? raw : raw.slice(0, i);
  return head.trim().toLowerCase();
}

// The human verbs train 4 strips to the word. Readers that render
// link_reason must drop everything after the first colon for any of
// these verbs so old rows never leak an email.
//
// Includes the matcher verbs too (ai, ai-new, ai-notfood, alias) so
// the one strip-list covers every prefix a parseReason has to handle;
// callers only pass this through `reasonVerb` before comparing.
export const ACTOR_VERBS: ReadonlySet<string> = new Set([
  "confirmed",
  "split",
  "relinked",
  "undo",
  "archived",
  "oneoff",
  "notfood",
  "keep_separate",
  "rescan_merge",
]);

export const AI_VERBS: ReadonlySet<string> = new Set([
  "ai",
  "ai-new",
  "ai-notfood",
  "alias",
]);

// True when this reason prefix was authored by a person (so its tail,
// if any, may carry an email) and should be stripped on render.
export function isActorReasonVerb(raw: string | null | undefined): boolean {
  return ACTOR_VERBS.has(reasonVerb(raw));
}

// The canonical state the UI should show. Readers (chip counts,
// linkCell label, PanelHead pill, Restore eligibility) call this; no
// caller branches on status/link_status/link_reason directly after
// train 4.
export function getVendorItemState(row: VendorItemStateInput): VendorItemState {
  const status = (row.status ?? "").toString();
  const linkStatus = (row.link_status ?? "").toString();
  const verb = reasonVerb(row.link_reason);

  if (status === "duplicate") return "duplicate";

  if (status === "one_off") return "one_off";
  if (status === "not_food") return "not_food";
  if (status === "archived") {
    // Old-shape one-off: archived + reason 'oneoff'. (172 rows on
    // b9ba0a7.) Everything else archived reads as archived.
    if (verb === "oneoff") return "one_off";
    return "archived";
  }

  // Person-marked not-food old shape: active + link_status='rejected' +
  // reason 'notfood' + is_food still true (intake did not flag). The
  // is_food guard rules out an intake-flagged row that also happens to
  // carry the same reason prefix.
  if (status === "active" && linkStatus === "rejected" && verb === "notfood") {
    return "not_food";
  }
  // Intake-flagged not food (AI classifier). The is_food=false carries
  // the fact; status is typically 'active'. Report as not_food so the
  // Vendor items chip and the panel head both show the same word.
  if (row.is_food === false) return "not_food";

  if (status === "resale") return "retail";
  if (linkStatus === "confirmed" && (status === "active" || status === "resale")) {
    // "resale" was handled above - this arm keeps the branch total.
    return "linked";
  }
  if (linkStatus === "proposed" && (status === "active" || status === "resale")) {
    return "proposed";
  }
  if (linkStatus === "none" && (status === "active" || status === "resale")) {
    return "not_linked";
  }
  if (linkStatus === "rejected") return "rejected";
  // Fallback - shouldn't be reachable with a valid row, but keep the
  // read-side total deterministic rather than throwing.
  return "not_linked";
}

// Sugar readers for the surfaces that ask the question in English.
export function isDecidedDisposition(row: VendorItemStateInput): boolean {
  const s = getVendorItemState(row);
  return s === "archived" || s === "one_off" || s === "not_food";
}

// Restore eligibility: an item can be restored only when its current
// state was set by a person (archived, one-off, or person-marked not
// food). Intake-flagged not-food rows (is_food=false) are NOT the
// person's call and have no Restore.
export function canRestore(row: VendorItemStateInput): boolean {
  const s = getVendorItemState(row);
  if (s === "archived" || s === "one_off") return true;
  if (s === "not_food" && row.is_food !== false) return true;
  return false;
}
