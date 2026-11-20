// Notes-and-history read model for one (account, date). Three
// sources merge into one newest-first list:
//   1. sc_daily_actuals: first-entered synthesis (earliest created
//      row for the day; `created_by` + `created_at`).
//   2. sc_daily_actuals_history: the per-service update + delete
//      receipts, written by the sc_daily_actuals_audit trigger.
//   3. sc_day_note_entries: authored and system notes (append-only
//      per v1's sc-9 and sc-25 shape).
//
// Each entry carries a kind + an author DISPLAY NAME (not an email)
// and a timestamp. The fold formatter in formatHistoryLine.ts turns
// each entry into one plain sentence.

export type EntryKind =
  | "first_entered"
  | "actual_change"
  | "actual_delete"
  | "note";

export interface FirstEnteredEntry {
  kind: "first_entered";
  authorDisplayName: string | null; // null when no name was resolved
  at: string;                       // ISO
}

export interface ActualChangeEntry {
  kind: "actual_change";
  serviceId: string;
  serviceName: string;              // "(archived service)" when unknown
  oldCount: number;
  newCount: number;
  authorDisplayName: string | null;
  at: string;
}

export interface ActualDeleteEntry {
  kind: "actual_delete";
  serviceId: string;
  serviceName: string;
  oldCount: number;
  authorDisplayName: string | null;
  at: string;
}

export interface NoteEntry {
  kind: "note";
  text: string;
  authorDisplayName: string | null; // null for legacy backfill (author=null)
  at: string;
  source: "bulk" | null;            // per sc_day_note_entries.source
}

export type HistoryEntry =
  | FirstEnteredEntry
  | ActualChangeEntry
  | ActualDeleteEntry
  | NoteEntry;

// A delete-group is a run of consecutive ActualDeleteEntry rows with
// the same author within two seconds of each other. The fold
// collapses them into one "Reset by <name>" line in the formatter.
export interface DeleteGroup {
  kind: "actual_delete_group";
  services: Array<{ serviceId: string; serviceName: string; oldCount: number }>;
  authorDisplayName: string | null;
  firstAt: string;
  lastAt: string;
}

export type RenderItem =
  | FirstEnteredEntry
  | ActualChangeEntry
  | ActualDeleteEntry
  | NoteEntry
  | DeleteGroup;

export interface NotesHistoryView {
  accountKey: string;
  serviceDate: string;
  items: RenderItem[]; // newest first after grouping
  totalCount: number;  // pre-grouping, for the fold's badge
}
