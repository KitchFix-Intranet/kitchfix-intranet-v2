"use client";

// N7 §3f: closed disclosure rows under the item + ingredient zones.
// Mark as retail + Merge still render inside IngredientBlock for
// commit 1; this wrapper handles Change history (lazy fetch on first
// open, N7 §3f + acceptance 7) so the panel issues one fewer request
// on mount.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { LedgerBlock } from "./LedgerBlock";

function DisclosureRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub: string;
  children: (open: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="kf-ipanel__drow"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="kf-ipanel__drow-label">{label}</span>
        <span className="kf-ipanel__drow-sub">{sub}</span>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          className={`kf-ipanel__drow-chev${open ? " is-open" : ""}`}
          aria-hidden
        />
      </button>
      {open ? <div className="kf-ipanel__drow-body">{children(open)}</div> : null}
    </>
  );
}

export function PanelClosedRows({
  ingredientId,
  itemId,
}: {
  ingredientId: string | null;
  itemId: string | null;
}) {
  return (
    <>
      <DisclosureRow
        label="Change history"
        sub="every change, newest first"
      >
        {(open) => (
          <LedgerBlock
            ingredientId={ingredientId}
            itemId={itemId}
            open={open}
          />
        )}
      </DisclosureRow>
    </>
  );
}
