"use client";

// N9: review card gets the panel's discipline. Layout only - no new
// query, no new column, no new fact. The queue's data shape and every
// handler in ReviewActions.tsx are byte-identical. All measurement
// comes from docs/renders/REVIEW_CARD_RENDER_REFERENCE.html.
//
// Crash guard (React 19 strict-mode): every onChange handler reads
// e.currentTarget.checked into a LOCAL variable BEFORE calling
// setChecked. Reading it inside the functional updater is a
// double-invoke trap - the second run sees a nulled SyntheticEvent.
// See docs/GOTCHAS.md.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Scale } from "lucide-react";
import { fmtCount, fmtDate, fmtPackNumbersInText, fmtUsd, fmtUsdLong, monthsAgo } from "@/lib/fmt";
import { deriveRecipePrice } from "@/lib/ingredients/measures";
import { uomLabel } from "@/lib/ingredients/pack";
import { ReviewActions } from "./ReviewActions";
import { DetailPanel, type DetailPanelOpen } from "./DetailPanel";
// N13.1 §3: site-pill primitives lifted out of review.css so each
// reader loads its own source. ReviewCard renders .kf-site-pill /
// .kf-site-pill--more; this import keeps the card self-sufficient
// against future review.css moves.
import "./site-pills.css";
import { RowFlagToggle } from "./RowFlagToggle";
import { computeReviewCardSpread } from "./reviewCardSpread";
import type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";

// Re-exported for every pre-existing import site. Declarations moved
// to ./itemTypes so the DetailPanel can be opened from the Ingredients
// pane (A1) without re-coupling to ReviewCard.
export type { ReviewCardIngredient, ReviewGroupItem } from "./itemTypes";

export type ReviewCardGroup = {
  key: string;
  kind: "existing" | "new";
  ingredient: ReviewCardIngredient | null;
  proposedName: string | null;
  proposedParent: string | null;
  totalUsd12m: number;
  totalLines12m: number;
  items: ReviewGroupItem[];
};

// N9 §2c pack source phrases. Four sources per Note A; when there
// is no source the caller omits the sub-line entirely (round 3 fix 4).
function packSourcePhrase(src: ReviewGroupItem["packSource"]): string | null {
  if (src === "override") return "by hand";
  if (src === "catalog") return "catalog";
  if (src === "invoice") return "invoice";
  if (src === "catalog_sibling") return "siblings";
  return null;
}

// N9 §2f: date is stale at 90+ days old. The trigger is days (so a
// boundary like 90 days exactly fires), the DISPLAY is monthsAgo
// (the "whole months elapsed" format the render shows: `5 mo ago`).
// Boundary samples:
//   30 days back  -> 0 (no marker)
//   89 days back  -> 0 (no marker)
//   90 days back  -> monthsAgo (2 or 3 depending on day-of-month)
//   200 days back -> 6 (shown as "6 mo ago")
function staleMonths(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 90) return 0;
  return monthsAgo(iso);
}

export function ReviewCard({
  group,
  ingredients,
}: {
  group: ReviewCardGroup;
  ingredients: ReviewCardIngredient[];
}) {
  const title =
    group.kind === "existing"
      ? group.ingredient?.name ?? "Unknown"
      : group.proposedName ?? "New ingredient";
  const parent = group.kind === "existing" ? group.ingredient?.parent ?? null : group.proposedParent;
  // Head low-confidence count: LOW rows only, per the ruling. Medium
  // rows carry a per-row pill but do not raise the head count.
  const lowCount = group.items.filter((it) => it.confidence === "low").length;
  const spread = useMemo(() => computeReviewCardSpread(group.items), [group.items]);

  // Default to every item selected. State keyed by vendor_item_id.
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const it of group.items) init[it.id] = true;
    return init;
  });

  const checkedIds = useMemo(
    () => group.items.filter((it) => checked[it.id]).map((it) => it.id),
    [checked, group.items]
  );
  const checkedItemsPreview = useMemo(
    () =>
      group.items
        .filter((it) => checked[it.id])
        .map((it) => ({
          id: it.id,
          displayName: it.displayName,
          vendor: it.vendor,
          pack: it.pack,
          billedUnit: it.billedUnit,
          // N10 §2c: fed to inferBaseUnit() in the New-ingredient
          // panel's Costed-per readout.
          packUom: it.packUom,
          usd12m: it.usd12m,
        })),
    [checked, group.items]
  );
  const checkedCount = checkedIds.length;
  const memberCount = group.items.length;
  const allChecked = memberCount > 0 && checkedCount === memberCount;
  const someChecked = checkedCount > 0 && !allChecked;
  const checkedUsd = useMemo(
    () => group.items.reduce((s, it) => (checked[it.id] ? s + it.usd12m : s), 0),
    [checked, group.items]
  );

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked;
  }, [someChecked]);

  function toggleAll(v: boolean) {
    const next: Record<string, boolean> = {};
    for (const it of group.items) next[it.id] = v;
    setChecked(next);
  }

  function toggleOne(id: string, v: boolean) {
    setChecked((prev) => ({ ...prev, [id]: v }));
  }

  // DetailPanel + leave animation (unchanged from today).
  const [panelOpen, setPanelOpen] = useState<DetailPanelOpen>(null);
  const ingredientRow = group.ingredient;
  const router = useRouter();
  const [leaving, setLeaving] = useState<{ ids: Set<string>; allLeaving: boolean } | null>(null);

  function startLeaveAnimation(itemIds: string[]) {
    const ids = new Set(itemIds);
    const allLeaving = itemIds.length === group.items.length;
    setLeaving({ ids, allLeaving });
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const delay = prefersReducedMotion ? 180 : 420;
    window.setTimeout(() => {
      router.refresh();
    }, delay);
  }

  // N9 §2d foot right text (moved out of the separate <footer> strip).
  const movesLine =
    checkedCount === 0
      ? "Select items to confirm."
      : checkedCount === memberCount
        ? `${fmtUsd(group.totalUsd12m)} moves to Linked when the whole group is confirmed`
        : `${fmtUsd(checkedUsd)} moves to Linked for the ${checkedCount} selected items`;

  const leavingAll = leaving?.allLeaving ?? false;
  return (
    <article
      className={`kf-rvc${group.kind === "new" ? " kf-rvc--new" : ""}${leavingAll ? " kf-rvc--leaving" : ""}`}
      aria-busy={leavingAll || undefined}
    >
      <header className="kf-rvc__head">
        <label className="kf-rvc__select-all" aria-label="Select all items in this group">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allChecked}
            aria-checked={someChecked ? "mixed" : allChecked ? "true" : "false"}
            onChange={(e) => {
              const v = e.currentTarget.checked;
              toggleAll(v);
            }}
          />
        </label>
        {ingredientRow ? (
          <button
            type="button"
            className="kf-rvc__title kf-rvc__title-btn"
            onClick={() => setPanelOpen({ kind: "ingredient" })}
            aria-label={`Edit ingredient ${title}`}
          >
            <span>{title}</span>
            <Pencil size={14} strokeWidth={1.5} aria-hidden />
          </button>
        ) : (
          <h3 className="kf-rvc__title">{title}</h3>
        )}
        <span className={`kf-pill ${group.kind === "new" ? "kf-pill--new" : "kf-pill--info"}`}>
          {group.kind === "new" ? "New ingredient" : "Existing match"}
        </span>
        {ingredientRow?.resale ? (
          <span className="kf-pill kf-pill--muted">Retail</span>
        ) : null}
        {lowCount > 0 ? (
          <span className="kf-pill kf-pill--warn">{fmtCount(lowCount)} low confidence</span>
        ) : null}
        {ingredientRow?.category || parent ? (
          <span className="kf-rvc__head-crumb">
            {[ingredientRow?.category ?? null, parent]
              .filter((s): s is string => !!s && s.trim().length > 0)
              .join(" · ")}
          </span>
        ) : ingredientRow && !ingredientRow.category ? (
          <span className="kf-pill kf-pill--warn">Needs category</span>
        ) : null}
        <HeadSpread spread={spread} />
        <div className="kf-rvc__totals">
          <strong>{fmtUsdLong(group.totalUsd12m)}</strong>
          <span>
            <b>{fmtCount(checkedCount)}</b> of {fmtCount(memberCount)} selected &middot; last 12 months
          </span>
        </div>
      </header>

      <table className="kf-rvc__items">
        {/* N9 §2b: fixed columns in this order. Widths quoted from
            the render. "Conf", "Lines", "Last purchase" are gone.
            Each <col> carries a class so the 760 px media rule can
            hide the <col> ALONGSIDE the matching <td>/<th>; hiding
            the cells without hiding the <col>s shifts every later
            cell onto the wrong <col> width under table-layout:
            fixed (round-2 regression). */}
        <colgroup>
          <col className="kf-rvc__col kf-rvc__col--sel" />
          <col className="kf-rvc__col kf-rvc__col--item" />
          <col className="kf-rvc__col kf-rvc__col--vendor" />
          <col className="kf-rvc__col kf-rvc__col--pack" />
          <col className="kf-rvc__col kf-rvc__col--price" />
          <col className="kf-rvc__col kf-rvc__col--annual" />
          <col className="kf-rvc__col kf-rvc__col--sites" />
          <col className="kf-rvc__col kf-rvc__col--activity" />
        </colgroup>
        <thead>
          <tr>
            <th className="kf-rvc__check-col" aria-label="Select"></th>
            <th>Item</th>
            <th>Vendor</th>
            <th>Pack</th>
            <th className="kf-table__num">Unit price</th>
            <th className="kf-table__num">Annual $</th>
            <th>Sites</th>
            <th>Activity</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((it) => {
            const isHigh = it.confidence === "high";
            const lowPillLabel =
              it.confidence === "low"
                ? "Low confidence"
                : it.confidence === "med"
                  ? "Medium confidence"
                  : null;
            // §2c: name alone when high + unflagged. Flagged always
            // shows its note. Reason shows when confidence isn't high
            // OR when there's an OCR line to carry.
            const showOcr =
              it.displayNameSource === "catalog" && it.vendorOcrName !== it.displayName;
            // N9 round 2 fix 5: reason shows only when confidence
            // is not high. A flagged high-confidence row carries
            // the flag note as its message - the matcher's reason
            // is not shown.
            const showReason = !!it.reason && !isHigh;
            const rowTag = ((): "lowest" | "highest" | null => {
              if (spread.kind !== "range" || spread.ratio === 1) return null;
              if (spread.minId === it.id) return "lowest";
              if (spread.maxId === it.id) return "highest";
              return null;
            })();
            const stale = staleMonths(it.lastSeen);
            return (
              <tr
                key={it.id}
                className={
                  (checked[it.id] ? "kf-rvc__row kf-rvc__row--on" : "kf-rvc__row") +
                  (leaving && !leavingAll && leaving.ids.has(it.id) ? " kf-rvc__row--leaving" : "") +
                  (it.flagged ? " kf-rvc__row--flagged" : "")
                }
              >
                <td className="kf-rvc__check-col">
                  <input
                    type="checkbox"
                    checked={!!checked[it.id]}
                    aria-label={`Select ${it.displayName}`}
                    onChange={(e) => {
                      const v = e.currentTarget.checked;
                      toggleOne(it.id, v);
                    }}
                  />
                </td>
                <td>
                  <div className="kf-rvc__nm">
                    <button
                      type="button"
                      className="kf-rvc__row-btn"
                      onClick={() => setPanelOpen({ kind: "item", itemId: it.id })}
                      title={`Open details for ${it.displayName}`}
                    >
                      {it.displayName}
                    </button>
                    {it.catchWeight ? (
                      <span
                        className="kf-flag kf-flag--warn"
                        role="img"
                        aria-label="Catch-weight item - priced by actual weight"
                        title="Catch-weight item - priced by actual weight. Open the item to re-cost as priced by the case."
                      >
                        <Scale size={14} strokeWidth={1.5} aria-hidden />
                      </span>
                    ) : null}
                    <RowFlagToggle
                      itemId={it.id}
                      flagged={it.flagged}
                      flagNote={it.flagNote}
                      flaggedBy={it.flaggedBy}
                    />
                  </div>
                  {it.flagged ? (
                    // N9 round 2 fix 5: upright micro, no inline
                    // icon - the row's flag toggle already carries
                    // the flag glyph.
                    <div className="kf-rvc__flag-note" title={it.flaggedBy ?? ""}>
                      Flagged{it.flaggedBy ? ` by ${it.flaggedBy}` : ""}
                      {it.flagNote ? `: "${it.flagNote}"` : ""}
                    </div>
                  ) : null}
                  {showOcr ? (
                    <div className="kf-rvc__ocr-line">{it.vendorOcrName}</div>
                  ) : null}
                  {lowPillLabel || showReason ? (
                    <div className="kf-rvc__low-line">
                      {lowPillLabel ? (
                        <span className="kf-pill kf-pill--warn">{lowPillLabel}</span>
                      ) : null}
                      {showReason ? <span>{it.reason}</span> : null}
                    </div>
                  ) : null}
                </td>
                <td>
                  <div className="kf-rvc__strong kf-cell-ellipsis">{it.vendor}</div>
                  <div className="kf-rvc__sublabel">
                    {it.itemNumber ? `#${it.itemNumber}` : "no item #"}
                  </div>
                </td>
                <td>
                  <div>
                    {it.packNormalized || it.pack ? (
                      <>
                        {fmtPackNumbersInText(it.packNormalized ?? it.pack)}
                        {it.billedUnit ? (
                          <span className="kf-muted"> / {it.billedUnit}</span>
                        ) : null}
                      </>
                    ) : (
                      // N9 round 2 fix 4: "no pack read" alone -
                      // without the dangling "/ case" the billed-unit
                      // fragment produced when there is no pack to
                      // pair it with.
                      <span className="kf-muted">no pack read</span>
                    )}
                  </div>
                  {(() => {
                    const phrase = packSourcePhrase(it.packSource);
                    return phrase ? (
                      <div className="kf-rvc__sublabel">{phrase}</div>
                    ) : null;
                  })()}
                </td>
                <td className="kf-table__num">
                  <UnitPriceCell item={it} ingredient={group.ingredient ?? null} rowTag={rowTag} />
                </td>
                <td className="kf-table__num kf-rvc__strong">
                  ${fmtUsdLong(it.usd12m).replace(/^\$/, "")}
                </td>
                <td>
                  {it.accounts.length > 0 ? (
                    <SitePills codes={it.accounts} max={3} />
                  ) : (
                    <span className="kf-muted">-</span>
                  )}
                </td>
                <td>
                  <div>{it.lines12m === 1 ? "1 line" : `${fmtCount(it.lines12m)} lines`}</div>
                  <div className="kf-rvc__sublabel">
                    {it.lastSeen ? fmtDate(it.lastSeen) : "-"}
                    {stale > 0 ? (
                      <>
                        {" "}&middot;{" "}
                        <span className="kf-rvc__activity-stale">{stale} mo ago</span>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ReviewActions
        kind={group.kind}
        currentIngredientId={group.ingredient?.id ?? null}
        ingredientResale={group.ingredient?.resale ?? false}
        proposedName={group.proposedName}
        proposedParent={group.proposedParent}
        ingredients={ingredients}
        checkedIds={checkedIds}
        checkedItems={checkedItemsPreview}
        checkedCount={checkedCount}
        memberCount={memberCount}
        onLeaveStart={startLeaveAnimation}
        movesLine={movesLine}
      />

      {leavingAll ? (
        <div className="kf-rvc__leaving-overlay" aria-live="polite" role="status">
          <Check size={28} strokeWidth={2} aria-hidden />
          <span>Confirmed. Leaving the queue.</span>
        </div>
      ) : null}

      {panelOpen ? (
        <DetailPanel
          open={panelOpen}
          onClose={() => setPanelOpen(null)}
          ingredient={ingredientRow}
          items={group.items}
          parents={ingredients}
          proposedName={group.proposedName}
          proposedParent={group.proposedParent}
        />
      ) : null}
    </article>
  );
}

// N9 §2a + §2e: head spread phrase.
function HeadSpread({ spread }: { spread: ReturnType<typeof computeReviewCardSpread> }) {
  if (spread.kind === "none") return null;
  if (spread.kind === "mixed") {
    return <span className="kf-rvc__head-spread">prices are in mixed units</span>;
  }
  const unit = spread.uom === "LB" ? "lb"
    : spread.uom === "FLOZ" ? "fl oz"
    : spread.uom === "EA" ? "each"
    : spread.uom.toLowerCase();
  const ratioLabel = spread.ratio.toFixed(1);
  return (
    <span className="kf-rvc__head-spread">
      <strong>{fmtUsd(spread.min)} to {fmtUsd(spread.max)}</strong> / {unit} &middot; {ratioLabel}x spread
    </span>
  );
}

// N9 §2c Unit price cell. Two lines, right-aligned, no chips.
function UnitPriceCell({
  item,
  ingredient,
  rowTag,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  rowTag: "lowest" | "highest" | null;
}) {
  const ingredientMeasure =
    ingredient?.each_measure_qty != null && ingredient?.each_measure_uom
      ? { qty: Number(ingredient.each_measure_qty), uom: ingredient.each_measure_uom }
      : null;
  const derived = deriveRecipePrice({
    perBase: item.perBase,
    perBaseUom: item.perBaseUom,
    itemMeasure: item.eachMeasure,
    ingredientMeasure,
  });
  const perUnitAvailable =
    item.perBase != null && item.perBaseUom != null && item.perBaseConfidence != null;
  const uomLower = item.perBaseUom
    ? item.perBaseUom === "LB" ? "lb"
      : item.perBaseUom === "FLOZ" ? "fl oz"
      : item.perBaseUom === "EA" ? "each"
      : item.perBaseUom.toLowerCase()
    : null;

  const confidenceWord =
    item.perBaseConfidence === "override" ? "override"
      : item.perBaseConfidence === "derived" ? "from spend"
      : item.perBaseConfidence === "high" ? "per-unit (high)"
      : item.perBaseConfidence === "low" ? "est. (low)"
      : null;

  // Secondary case figure: catalog first, billed-latest as fallback.
  // The label "case" is always present - no doubled-unit bug.
  const secondary = item.catalogPrice != null
    ? { amount: item.catalogPrice, label: "catalog" }
    : item.unitPrice != null
      ? { amount: item.unitPrice, label: "billed" }
      : null;

  const title = perUnitAvailable
    ? (item.perBaseConfidence === "override"
        ? "Human-attested override (structured)"
        : item.perBaseConfidence === "derived"
          ? "Blended from actual invoice spend"
          : item.perBaseConfidence === "high"
            ? "Per-unit estimate from pack size + case price"
            : "Low-confidence estimate (range / catch-weight / soft parse)") +
      (item.perBaseNote ? ` - ${item.perBaseNote}` : "") +
      (derived ? ` · ${fmtUsd(item.perBase as number)} each ÷ ${derived.qty} ${uomLabel(derived.measureUom)}` : "")
    : "Per-unit needs pack normalization - edit the pack in the detail panel";

  const ownMeasure = derived && derived.from === "item";
  return (
    <div className="kf-rvc__price" title={title}>
      <div className="kf-rvc__price-main">
        {rowTag ? <span className="kf-ipanel__tag">{rowTag}</span> : null}
        {perUnitAvailable ? (
          <>
            <strong>{fmtUsd(item.perBase as number)}</strong>
            <span className="kf-muted"> / {uomLower}</span>
            {derived ? (
              <span className="kf-rvc__price-derived">
                {fmtUsd(derived.per)} / {uomLabel(derived.uom)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <strong className="kf-muted">-</strong>
            <span className="kf-muted"> / unit</span>
          </>
        )}
      </div>
      <div className="kf-rvc__price-sub">
        {/* N9 round 2 fix 3: own-measure moves to the START of line 2
            so line 1 stays tag + price + derived and never overlaps
            the Pack cell. */}
        {ownMeasure ? <span className="kf-rvc__own-measure">own measure</span> : null}
        {ownMeasure && (secondary || confidenceWord) ? <> &middot; </> : null}
        {secondary ? (
          <>
            {fmtUsd(secondary.amount)} case ({secondary.label})
            {confidenceWord ? <> &middot; {confidenceWord}</> : null}
          </>
        ) : confidenceWord ? (
          <>{confidenceWord}</>
        ) : ownMeasure ? null : (
          <>needs pack</>
        )}
      </div>
    </div>
  );
}

// Site pills: render the item's account-code list as chips (e.g.
// STL-FL, TXR-AZ). Max=3 with "+N" overflow pill when the list is
// longer. Account codes are stable short identifiers.
function SitePills({ codes, max }: { codes: string[]; max: number }) {
  const shown = codes.slice(0, max);
  const hidden = codes.length - shown.length;
  return (
    <span className="kf-site-pills" aria-label={`Sites: ${codes.join(", ")}`}>
      {shown.map((c) => (
        <span key={c} className="kf-site-pill">{c}</span>
      ))}
      {hidden > 0 ? <span className="kf-site-pill kf-site-pill--more">+{hidden}</span> : null}
    </span>
  );
}
