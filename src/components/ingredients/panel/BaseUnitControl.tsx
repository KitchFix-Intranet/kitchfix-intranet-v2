"use client";

// N7 B6: extracted from IngredientMastersFilter.tsx so both the
// Ingredients tab row and the item panel's ingredient zone can mount
// the same writer. Markup and behaviour are unchanged - BASE_UNIT_GROUPS
// + uomLabel come from pack.ts so the dropdown is still the one
// vocabulary N6 established.
//
// Prop type narrowed to the three fields the control actually reads
// (id / name / baseUnit) so the panel can pass a thin shape without a
// cast through MasterRow.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Scale } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { WEIGHT_UOMS, VOLUME_UOMS, uomLabel } from "@/lib/ingredients/pack";
import { postJson, errMsg } from "./common";

export type BaseUnitControlRow = {
  id: string;
  name: string;
  baseUnit: string;
};

// N6: dropdown options come from the shared vocabulary. Weight and
// volume groups are offered as <optgroup>s; count stays last.
const BASE_UNIT_GROUPS: { label: string; options: string[] }[] = [
  { label: "Weight", options: WEIGHT_UOMS.map((u) => u.toLowerCase()) },
  { label: "Volume", options: VOLUME_UOMS.map((u) => u.toLowerCase()) },
  { label: "Count",  options: ["each", "dozen"] },
];

export function BaseUnitControl({
  row,
  onSaved,
}: {
  row: BaseUnitControlRow;
  // N7 B6: callers can observe a successful save to trigger their own
  // refetch (the ById wrappers need this since router.refresh does not
  // invalidate their client-fetched state). Defaults to router.refresh.
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function save(next: string) {
    if (next === row.baseUnit || busy) return;
    setBusy(true);
    const r = await postJson("/api/review/set-base-unit", {
      ingredientId: row.id,
      baseUnit: next,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Save failed (${r.status})`), { tone: "block" });
      setBusy(false);
      return;
    }
    toast(`${row.name} is now costed per ${next}`);
    setBusy(false);
    if (onSaved) onSaved();
    else router.refresh();
  }

  return (
    <span className="kf-dt__unitctl">
      <Scale size={13} strokeWidth={1.5} aria-hidden />
      <label className="kf-dt__unitctl-l" htmlFor={`bu-${row.id}`}>
        Costed per
      </label>
      <select
        id={`bu-${row.id}`}
        className="kf-dt__unitsel"
        value={row.baseUnit}
        disabled={busy}
        onChange={(e) => save(e.target.value)}
      >
        {BASE_UNIT_GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((u) => (
              <option key={u} value={u}>{uomLabel(u)}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </span>
  );
}
