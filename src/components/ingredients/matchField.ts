// T7 ruling 3 + item 5: pure matcher for the Ingredients / Retail
// search. Returns which FIELD the needle hit, so the list row can
// say "Has item number 12345" or "Has item: ..." when the
// ingredient's own name did not match. Lives in its own file (no
// CSS or React imports) so scripts/ can import it under tsx without
// pulling the whole tab's stylesheet.

import type { MasterRow, MasterLinkedItem } from "./IngredientMastersFilter";

export type MasterMatchField =
  | "name"
  | "parent"
  | "category"
  | "item"
  | "itemNumber"
  | "vendor";

export type MasterMatch =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "hit"; field: MasterMatchField; item?: MasterLinkedItem };

// Precedence: name > parent > category > item name > item number >
// vendor. The first hit wins. The returned `item` is the linked item
// that triggered an item / itemNumber / vendor hit, so the row's
// "Has item ..." sub-line can quote its name or number directly.
export function matchField(row: MasterRow, needle: string): MasterMatch {
  if (!needle) return { kind: "all" };
  const n = needle.toLowerCase();
  if (row.name.toLowerCase().includes(n)) return { kind: "hit", field: "name" };
  if (row.parent && row.parent.toLowerCase().includes(n)) return { kind: "hit", field: "parent" };
  if (row.category && row.category.toLowerCase().includes(n)) return { kind: "hit", field: "category" };
  for (const li of row.linkedItems) {
    if (li.name.toLowerCase().includes(n)) return { kind: "hit", field: "item", item: li };
  }
  for (const li of row.linkedItems) {
    if (li.itemNumber && li.itemNumber.toLowerCase().includes(n)) {
      return { kind: "hit", field: "itemNumber", item: li };
    }
  }
  for (const li of row.linkedItems) {
    if (li.vendor.toLowerCase().includes(n)) return { kind: "hit", field: "vendor", item: li };
  }
  return { kind: "none" };
}

export function matches(row: MasterRow, needle: string): boolean {
  const m = matchField(row, needle);
  return m.kind === "all" || m.kind === "hit";
}
