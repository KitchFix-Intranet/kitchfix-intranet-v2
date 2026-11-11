"use client";

// Right-side slide-in detail panel for the review queue. One instance
// per ReviewCard; opens via local useState from the card's row buttons
// (kind: "item") or the header title button (kind: "ingredient").
//
// Shape:
//   - Ingredient section (always, when ingredient exists): rename,
//     category (super) + sub (parent), resale toggle. Each sub-form has
//     its own Save; successful writes router.refresh() so the pre-
//     rendered server cards re-read the DB.
//   - Item section (only when kind=item): item facts (name, vendor, #,
//     pack, unit, 12m $, lines, sites, last seen, confidence, unit
//     price) + pack-override form.
//
// Reuses the kf-drawer* CSS from drawer.css for the backdrop + slide-in
// mechanics; the panel-internal form styles live in review.css under
// kf-dpn__*. Owns its own Esc / backdrop / focus-trap handling - not
// coupled to a URL param (unlike the vendor-item DrawerFrame).
//
// N7 commit 0: the block-by-block guts of the panel have been extracted
// verbatim to ./panel/*.tsx so the file reads as a shell. Markup,
// classes, save triggers and fetch semantics are unchanged - only the
// file layout moved. Follow-up commits re-chrome the composition.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";
import { ItemFacts } from "./panel/ItemFacts";
import { IngredientBlock } from "./panel/IngredientBlock";
import { PendingIngredientBlock } from "./panel/PendingIngredientBlock";
import { ItemPanelBody } from "./panel/ItemPanelBody";
import { LedgerBlock } from "./panel/LedgerBlock";
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
}: {
  open: Exclude<DetailPanelOpen, null>;
  onClose: () => void;
  // null for ai-new groups where the ingredient doesn't exist yet.
  // The item facts section still renders; the ingredient-edit section
  // shows a "create ingredient first" placeholder instead.
  ingredient: ReviewCardIngredient | null;
  items: ReviewGroupItem[];
  parents: ReviewCardIngredient[];
  proposedName?: string | null;
  proposedParent?: string | null;
}) {
  const router = useRouter();
  const labelId = useId();
  const asideRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [closing, setClosing] = useState(false);

  // Unique parents from the ingredients list, sorted. Used by the
  // sub-category dropdown. New parents are allowed via the inline
  // "add new sub-category" input.
  const parentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of parents) {
      if (p.parent && p.parent.trim().length > 0) set.add(p.parent);
    }
    return Array.from(set).sort();
  }, [parents]);

  const item = open.kind === "item" ? items.find((i) => i.id === open.itemId) ?? null : null;

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, EXIT_MS);
  };

  useEffect(() => {
    closeBtnRef.current?.focus();
    // Lock the page behind the modal panel; restore whatever it was.
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

        <div className="kf-drawer__head">
          <span className="kf-eyebrow kf-eyebrow--plain">
            {open.kind === "item" ? "Vendor item" : "Ingredient"}
          </span>
          <h3 id={labelId} className="kf-drawer__name">
            {open.kind === "item" && item
              ? item.displayName
              : ingredient
                ? ingredient.name
                : proposedName ?? "New ingredient"}
          </h3>
          <div className="kf-drawer__chips">
            {ingredient ? (
              <>
                {ingredient.category ? (
                  <span className="kf-pill kf-pill--muted">{ingredient.category}</span>
                ) : (
                  <span className="kf-pill kf-pill--warn">Needs category</span>
                )}
                {ingredient.parent ? (
                  <span className="kf-pill kf-pill--muted">{ingredient.parent}</span>
                ) : null}
                {ingredient.resale ? <span className="kf-pill kf-pill--muted">Retail</span> : null}
              </>
            ) : (
              <span className="kf-pill kf-pill--warn">Not yet created</span>
            )}
          </div>
        </div>

        {open.kind === "item" && item ? (
          <ItemFacts item={item} />
        ) : null}

        {ingredient ? (
          <IngredientBlock
            ingredient={ingredient}
            parentOptions={parentOptions}
            parents={parents}
            onDone={() => router.refresh()}
          />
        ) : (
          <PendingIngredientBlock
            proposedName={proposedName ?? null}
            proposedParent={proposedParent ?? null}
          />
        )}

        {open.kind === "item" && item ? (
          <ItemPanelBody item={item} ingredient={ingredient} onDone={() => router.refresh()} />
        ) : null}

        <LedgerBlock
          ingredientId={ingredient?.id ?? null}
          itemId={open.kind === "item" ? open.itemId : null}
        />
      </aside>
    </>
  );
}
