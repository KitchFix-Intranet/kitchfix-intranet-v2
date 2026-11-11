"use client";

// Right-side slide-in detail panel for the review queue.
//
// N7 commit 1 (structure):
//   head (§3a)
//   summary strip (§3b, item modes)
//   attention (§3c, item modes - only when there is something)
//   item editor blocks (§3d - PackOverrideBlock, ItemGradeBlock,
//                       PriceOverrideBlock, EvidenceSection)
//   ingredient editor (§3e - rename, category, Costed per [N7],
//                      each measure, resale, allergens, merge)
//   closed rows (§3f - Change history, lazy on first open)
//
// Shell owns: drawer chrome (backdrop, slide-in, focus trap, Escape).
// All sub-blocks live in ./panel/*. B4: PackOverride/ItemGrade/
// PriceOverride/EvidenceBody/LedgerBlock keep their internal markup
// and classes; only their wrapper changed.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";
import { IngredientBlock } from "./panel/IngredientBlock";
import { PendingIngredientBlock } from "./panel/PendingIngredientBlock";
import { ItemGradeBlock } from "./panel/ItemGradeBlock";
import { PackOverrideBlock } from "./panel/PackOverrideBlock";
import { PriceOverrideBlock } from "./panel/PriceOverrideBlock";
import { EvidenceSection } from "./panel/EvidenceSection";
import { PanelHead } from "./panel/PanelHead";
import { PanelStrip } from "./panel/PanelStrip";
import { PanelAttention, computeAttentionCounts } from "./panel/PanelAttention";
import { PanelClosedRows } from "./panel/PanelClosedRows";
import type { PackHint } from "./panel/packHelpers";
import "./drawer.css";

export type DetailPanelOpen =
  | null
  | { kind: "item"; itemId: string }
  | { kind: "ingredient" };

const EXIT_MS = 200;

export function DetailPanel({
  open,
  onClose,
  ingredient,
  items,
  parents,
  proposedName,
  proposedParent,
  onInvalidate,
}: {
  open: Exclude<DetailPanelOpen, null>;
  onClose: () => void;
  // null for ai-new groups where the ingredient doesn't exist yet.
  ingredient: ReviewCardIngredient | null;
  items: ReviewGroupItem[];
  parents: ReviewCardIngredient[];
  proposedName?: string | null;
  proposedParent?: string | null;
  // N7 B6: callers that fetch panel data themselves (ItemPanelById /
  // IngredientPanelById) pass a refetch fn; it fires after any panel
  // write that would change the data the wrapper fetched. ReviewCard
  // leaves it undefined and router.refresh() handles the server-side
  // path.
  onInvalidate?: () => void;
}) {
  const router = useRouter();
  const labelId = useId();
  const asideRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [closing, setClosing] = useState(false);
  // N7: pack-hint fed from PanelAttention's "Fix the pack" button into
  // PackOverrideBlock (same mechanism as the pre-N7 ItemPanelBody).
  const [packHint, setPackHint] = useState<PackHint | null>(null);

  const parentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of parents) {
      if (p.parent && p.parent.trim().length > 0) set.add(p.parent);
    }
    return Array.from(set).sort();
  }, [parents]);

  const item = open.kind === "item" ? items.find((i) => i.id === open.itemId) ?? null : null;

  // N7 B6: any onDone from a sub-block invalidates the parent's view.
  const onDone = () => {
    router.refresh();
    if (onInvalidate) onInvalidate();
  };

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, EXIT_MS);
  };

  useEffect(() => {
    closeBtnRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab" && asideRef.current) {
        const focusables = asideRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex="0"], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Head status pill count (shared with PanelAttention via
  // computeAttentionCounts).
  const attentionCounts = open.kind === "item" && item
    ? computeAttentionCounts(item, ingredient)
    : { total: 0, hasNoIngredient: false, provenance: { packHandSet: false, priceHandSet: false } };

  return (
    <>
      <div
        className={`kf-drawer__backdrop${closing ? " is-closing" : ""}`}
        onClick={close}
        aria-hidden
      />
      <aside
        ref={asideRef}
        className={`kf-drawer${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <button
          type="button"
          ref={closeBtnRef}
          className="kf-drawer__close"
          onClick={close}
          aria-label="Close"
        >
          <X size={20} strokeWidth={1.5} />
        </button>

        <PanelHead
          labelId={labelId}
          kind={open.kind}
          item={item}
          ingredient={ingredient}
          proposedName={proposedName}
          attentionCount={attentionCounts.total}
        />

        {open.kind === "item" && item ? (
          <PanelStrip item={item} ingredient={ingredient} />
        ) : null}

        {open.kind === "item" && item ? (
          <PanelAttention
            item={item}
            ingredient={ingredient}
            onFixPack={(uom) => setPackHint({ uom, nonce: Date.now() })}
          />
        ) : null}

        {open.kind === "item" && item ? (
          <>
            <ItemGradeBlock item={item} onDone={onDone} />
            <PackOverrideBlock item={item} ingredient={ingredient} hint={packHint} onDone={onDone} />
            <PriceOverrideBlock item={item} ingredient={ingredient} onDone={onDone} />
          </>
        ) : null}

        {ingredient ? (
          <IngredientBlock
            ingredient={ingredient}
            parentOptions={parentOptions}
            parents={parents}
            onDone={onDone}
          />
        ) : (
          <PendingIngredientBlock
            proposedName={proposedName ?? null}
            proposedParent={proposedParent ?? null}
          />
        )}

        {open.kind === "item" && item ? <EvidenceSection item={item} /> : null}

        <PanelClosedRows
          ingredientId={ingredient?.id ?? null}
          itemId={open.kind === "item" ? open.itemId : null}
        />
      </aside>
    </>
  );
}
