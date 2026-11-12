"use client";

// N7 B6: extracted from IngredientMastersFilter.tsx so the item
// panel's ingredient zone can mount the same writer. Markup and
// behaviour are unchanged - BASE_UNIT_GROUPS + uomLabel come from
// pack.ts so the dropdown is still the one vocabulary N6 established.
//
// N12: the tab-chrome variant is gone - the Ingredients tab no longer
// mounts BaseUnitControl directly; the control only renders inside
// PanelIngredientZone, where the row provides the label and the chrome.
// Prop type narrowed to the three fields the control actually reads.

import { useState } from "react";
import { useRouter } from "next/navigation";
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
    <select
      id={`bu-${row.id}`}
      className="kf-ipanel__ctl"
      value={row.baseUnit}
      disabled={busy}
      onChange={(e) => {
        const v = e.target.value;
        save(v);
      }}
      aria-label="Costed per"
    >
      {BASE_UNIT_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((u) => (
            <option key={u} value={u}>{uomLabel(u)}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
