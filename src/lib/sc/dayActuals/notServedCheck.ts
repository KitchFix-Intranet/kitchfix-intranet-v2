// Pure helper for the "Marked not served" system note (train 4
// fix 4). A day is "not served" when every projected line on the
// day has an actuals row at 0. A partial-zero shape (one zero,
// others still blank) is NOT "not served".
//
// The route reads projections + actuals before and after the save;
// the note fires only when the day flipped TO not-served by this
// save, not every time a zero-day is saved again.

export interface NotServedShape {
  projectedServiceIds: Set<string>;
  actualCountByServiceId: Map<string, number>;
}

export function isMarkedNotServed(shape: NotServedShape): boolean {
  if (shape.projectedServiceIds.size === 0) return false;
  for (const id of shape.projectedServiceIds) {
    const n = shape.actualCountByServiceId.get(id);
    if (n === undefined) return false;  // blank line
    if (n !== 0) return false;
  }
  return true;
}
