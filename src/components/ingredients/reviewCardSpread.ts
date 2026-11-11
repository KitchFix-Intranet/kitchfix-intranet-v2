// N9 §2e: group-level price spread, computed in the card from data
// already on the rows. Pure. No new SELECT, no new prop.
//
//   all share one perBaseUom and there are two or more:
//     { kind: "range", min, max, uom, ratio, minId, maxId }
//   more than one perBaseUom:
//     { kind: "mixed" }
//   fewer than two priced items:
//     { kind: "none" }

import type { ReviewGroupItem } from "./itemTypes";

export type ReviewCardSpread =
  | { kind: "none" }
  | { kind: "mixed" }
  | {
      kind: "range";
      min: number;
      max: number;
      uom: string;
      ratio: number;
      minId: string;
      maxId: string;
    };

export function computeReviewCardSpread(items: ReviewGroupItem[]): ReviewCardSpread {
  const priced = items.filter((it) => it.perBase != null && it.perBaseUom != null);
  if (priced.length < 2) return { kind: "none" };
  const uom = priced[0].perBaseUom as string;
  if (priced.some((it) => it.perBaseUom !== uom)) return { kind: "mixed" };
  let min = priced[0].perBase as number;
  let max = priced[0].perBase as number;
  let minId = priced[0].id;
  let maxId = priced[0].id;
  for (let i = 1; i < priced.length; i++) {
    const v = priced[i].perBase as number;
    // Ties tag the first - do not reassign on equality.
    if (v < min) { min = v; minId = priced[i].id; }
    if (v > max) { max = v; maxId = priced[i].id; }
  }
  if (min === max) return { kind: "range", min, max, uom, ratio: 1, minId, maxId: minId };
  const ratio = Math.round((max / min) * 10) / 10;
  return { kind: "range", min, max, uom, ratio, minId, maxId };
}
