// Pure: one plain English sentence per rendered history item.
//
// Author rendering:
//   - A resolved display name shows as-is.
//   - An unresolved email -> "Someone" (per Kevin correction 3).
//   - A legacy note with a null author shows no name.
//
// Grouping: consecutive ActualDeleteEntry rows by the same author
// within two seconds collapse into a DeleteGroup. The 2-second
// boundary is inclusive at "exactly 2.000s"; an entry that falls
// outside the window starts a new group.

import type {
  HistoryEntry,
  RenderItem,
  ActualDeleteEntry,
  DeleteGroup,
  FirstEnteredEntry,
  ActualChangeEntry,
  NoteEntry,
} from "./types";

export const DELETE_GROUP_WINDOW_MS = 2000;

// Build the render list. Expects `entries` newest-first.
export function groupHistory(entries: readonly HistoryEntry[]): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.kind !== "actual_delete") {
      out.push(e);
      i += 1;
      continue;
    }
    // Start a run; scan forward.
    const run: ActualDeleteEntry[] = [e];
    let j = i + 1;
    while (j < entries.length) {
      const next = entries[j];
      if (next.kind !== "actual_delete") break;
      if (next.authorDisplayName !== run[run.length - 1].authorDisplayName) break;
      const dt = Math.abs(Date.parse(run[run.length - 1].at) - Date.parse(next.at));
      if (!Number.isFinite(dt) || dt > DELETE_GROUP_WINDOW_MS) break;
      run.push(next);
      j += 1;
    }
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      const sortedAsc = run.slice().sort((a, b) => a.at.localeCompare(b.at));
      const group: DeleteGroup = {
        kind: "actual_delete_group",
        services: run.map((r) => ({
          serviceId: r.serviceId,
          serviceName: r.serviceName,
          oldCount: r.oldCount,
        })),
        authorDisplayName: run[0].authorDisplayName,
        firstAt: sortedAsc[0].at,
        lastAt: sortedAsc[sortedAsc.length - 1].at,
      };
      out.push(group);
    }
    i = j;
  }
  return out;
}

export function describeFirstEntered(e: FirstEnteredEntry): string {
  const name = e.authorDisplayName ?? "Someone";
  return `Entered by ${name}`;
}

export function describeActualChange(e: ActualChangeEntry): string {
  const name = e.authorDisplayName ?? "Someone";
  if (e.newCount === 0) {
    return `Cleared by ${name}: ${e.serviceName} (was ${e.oldCount})`;
  }
  return `Changed by ${name}: ${e.serviceName} ${e.oldCount} to ${e.newCount}`;
}

export function describeActualDelete(e: ActualDeleteEntry): string {
  const name = e.authorDisplayName ?? "Someone";
  return `Reset by ${name}: ${e.serviceName} (was ${e.oldCount})`;
}

export function describeDeleteGroup(g: DeleteGroup): string {
  const name = g.authorDisplayName ?? "Someone";
  const n = g.services.length;
  return `Reset by ${name}: ${n} service${n === 1 ? "" : "s"} cleared`;
}

export function describeNote(e: NoteEntry): string {
  // Note text is shown verbatim as its own paragraph; the top line
  // names the author and time. The formatter returns the author
  // attribution; the component renders the text separately.
  if (!e.authorDisplayName) return "";
  return e.authorDisplayName;
}

// Entry point: a stable string per render item for debug + tests.
export function describeItem(item: RenderItem): string {
  switch (item.kind) {
    case "first_entered":        return describeFirstEntered(item);
    case "actual_change":        return describeActualChange(item);
    case "actual_delete":        return describeActualDelete(item);
    case "actual_delete_group":  return describeDeleteGroup(item);
    case "note":                 return describeNote(item);
  }
}
