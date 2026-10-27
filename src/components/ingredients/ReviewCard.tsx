"use client";

// Client component: owns the per-item selection state (keyed by stable
// vendor_item_id, never by array index) and renders a checkbox column on
// every row by default. A group-level select-all / none sits in the card
// header; the "N of M selected / $X will move to Linked" line updates
// live as boxes toggle, and is correct at zero (Confirm disabled, zero
// total).
//
// Crash fix (was: ReviewActions.tsx:221): every onChange handler reads
// e.currentTarget.checked into a LOCAL variable before calling
// setChecked. Reading it inside the functional updater (`setChecked(prev
// => ({ ..., [id]: e.currentTarget.checked }))`) is a React 19 strict-mode
// trap - the double-invoked updater runs after the SyntheticEvent has
// nulled currentTarget, which throws on the second invocation. See
// docs/GOTCHAS.md.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Scale } from "lucide-react";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { ReviewActions } from "./ReviewActions";
import { DetailPanel, type DetailPanelOpen } from "./DetailPanel";

export type ReviewGroupItem = {
  id: string;
  // vendorOcrName = the raw invoice/OCR description (verbatim identifier).
  // displayName = catalog clean_name when matched, else the OCR name.
  // Casing rule: never Title-case OCR text; show it de-emphasized when
  // the catalog clean_name is doing the top-line display.
  name: string; // kept as alias for displayName for back-compat with any legacy readers
  vendorOcrName: string;
  displayName: string;
  displayNameSource: "catalog" | "invoice";
  vendor: string;
  itemNumber: string | null;
  pack: string | null;
  packNormalized: string | null;
  packState: string;
  packSource: "override" | "catalog" | "invoice" | null;
  packManualOverride: boolean;
  billedUnit: string | null;
  usd12m: number;
  lines12m: number;
  // accounts carries the full array of account codes (e.g. STL-FL, TXR-AZ)
  // so the DetailPanel can render them as pills instead of a count.
  accounts: string[];
  accountsCount: number;
  lastSeen: string | null;
  confidence: string | null;
  reason: string;
  catchWeight: boolean;
  unitPrice: number | null;
  unitPriceUnit: string | null;
  catalogPrice: number | null;
  gtin: string | null;
  // Backfilled per-base price (step 5 Phase 1). perBase + perBaseUom
  // only populated when the parser was high/low confident AND a case
  // price was available. perBaseConfidence='high' renders a quiet check
  // chip; 'low' renders an amber "est." chip; 'override' renders a
  // sturdier green "override" chip (human-attested, Phase 1.8); null
  // falls back to the catalog-or-billed case price display.
  perBase: number | null;
  perBaseUom: string | null;
  perBaseConfidence: "high" | "low" | "override" | null;
  perBaseNote: string | null;
  caseSource: "catalog" | "billed" | "catch_weight" | "catalog_lb" | "override" | null;
};

export type ReviewCardIngredient = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  resale: boolean;
};

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

export function ReviewCard({
  group,
  ingredients,
}: {
  group: ReviewCardGroup;
  ingredients: ReviewCardIngredient[];
}) {
  const title = group.kind === "existing" ? group.ingredient?.name ?? "Unknown" : group.proposedName ?? "New ingredient";
  const parent = group.kind === "existing" ? group.ingredient?.parent ?? null : group.proposedParent;
  const hasLow = group.items.some((it) => it.confidence === "low");

  // Default to every item selected. State keyed by vendor_item_id so
  // nothing shifts if the parent re-renders with a reordered list.
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const it of group.items) init[it.id] = true;
    return init;
  });

  const checkedIds = useMemo(
    () => group.items.filter((it) => checked[it.id]).map((it) => it.id),
    [checked, group.items]
  );
  // Minimal item preview rows for the New-ingredient form so Kevin
  // sees what he's building the new ingredient out of (name, vendor,
  // pack, annual spend).
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

  // <input type="checkbox"> has no "indeterminate" prop in React; set it
  // imperatively on the DOM node so a partial selection shows the
  // tri-state glyph. React's strict-mode double-invoke of this effect is
  // safe (same DOM op twice).
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
    // v captured BEFORE setChecked so the updater never reads from a
    // stale SyntheticEvent during React 19 strict-mode double-invoke.
    setChecked((prev) => ({ ...prev, [id]: v }));
  }

  // Detail-panel state. One panel per card (if Kevin opens a panel in
  // another card, this card's panel stays open until explicitly closed;
  // minor UX trade for simpler state). Opens via the item-name button on
  // a row (kind: "item") or the group-title button in the header (kind:
  // "ingredient"). Only existing-match groups have an ingredient to edit;
  // ai-new groups show the ingredient panel disabled (can't rename a
  // not-yet-created ingredient).
  const [panelOpen, setPanelOpen] = useState<DetailPanelOpen>(null);
  const ingredientRow = group.ingredient; // null for ai-new groups

  // Confirm leave-animation state. When ReviewActions reports a
  // successful Confirm, we flip into "leaving" mode: the whole card
  // dims + shows a check overlay if every item left, otherwise only
  // the affected rows do. After the CSS transition (~400ms, or 150ms
  // in reduced-motion), we trigger router.refresh() so the server
  // data drops the confirmed rows. Undo during the ~6s toast window
  // still works - it just reverses the DB state and the next refresh
  // brings the rows back.
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
      // router.refresh() re-fetches the server data; the card either
      // unmounts (all items left) or re-renders with fewer rows. Our
      // local leaving state is wiped when the parent re-renders with
      // fresh group.items.
      router.refresh();
    }, delay);
  }

  const footerLine =
    checkedCount === 0
      ? "Select items to confirm."
      : checkedCount === memberCount
        ? `${fmtUsd(group.totalUsd12m)} will move to Linked when the whole group is confirmed.`
        : `${fmtUsd(checkedUsd)} will move to Linked for the ${checkedCount} selected items.`;

  const leavingAll = leaving?.allLeaving ?? false;
  return (
    <article
      className={`kf-rvc${group.kind === "new" ? " kf-rvc--new" : ""}${leavingAll ? " kf-rvc--leaving" : ""}`}
      aria-busy={leavingAll || undefined}
    >
      <header className="kf-rvc__head">
        <div className="kf-rvc__title-wrap">
          <label className="kf-rvc__select-all" aria-label="Select all items in this group">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allChecked}
              aria-checked={someChecked ? "mixed" : allChecked ? "true" : "false"}
              onChange={(e) => {
                // Capture outside the updater (crash guard).
                const v = e.currentTarget.checked;
                toggleAll(v);
              }}
            />
          </label>
          <span className={`kf-pill ${group.kind === "new" ? "kf-pill--warn" : "kf-pill--info"}`}>
            {group.kind === "new" ? "New ingredient" : "Existing match"}
          </span>
          {hasLow ? <span className="kf-pill kf-pill--muted">Low confidence inside</span> : null}
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
          {parent ? <span className="kf-rvc__parent">{parent}</span> : null}
          {ingredientRow?.category ? (
            <span className="kf-pill kf-pill--muted">{ingredientRow.category}</span>
          ) : ingredientRow && !ingredientRow.category ? (
            <span className="kf-pill kf-pill--warn">Needs category</span>
          ) : null}
          {ingredientRow?.resale ? (
            <span className="kf-pill kf-pill--muted">Resale</span>
          ) : null}
        </div>
        <div className="kf-rvc__totals">
          <strong>{fmtUsdLong(group.totalUsd12m)}</strong>
          <span>
            {fmtCount(checkedCount)} of {fmtCount(memberCount)} selected
            {checkedCount > 0 && checkedCount < memberCount ? ` · ${fmtUsd(checkedUsd)}` : ""}
          </span>
        </div>
      </header>

      <table className="kf-rvc__items">
        <thead>
          <tr>
            <th className="kf-rvc__check-col" aria-label="Select"></th>
            <th>Item</th>
            <th>Vendor / #</th>
            <th>Pack / unit</th>
            <th className="kf-table__num">Unit price</th>
            <th className="kf-table__num">Annual $</th>
            <th className="kf-table__num">Lines</th>
            <th>Sites</th>
            <th>Last purchase</th>
            <th>Conf</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((it) => (
            <tr
              key={it.id}
              className={
                (checked[it.id] ? "kf-rvc__row kf-rvc__row--on" : "kf-rvc__row") +
                (leaving && !leavingAll && leaving.ids.has(it.id) ? " kf-rvc__row--leaving" : "")
              }
            >
              <td className="kf-rvc__check-col">
                <input
                  type="checkbox"
                  checked={!!checked[it.id]}
                  aria-label={`Select ${it.displayName}`}
                  onChange={(e) => {
                    // Capture outside the updater (crash guard).
                    const v = e.currentTarget.checked;
                    toggleOne(it.id, v);
                  }}
                />
              </td>
              <td title={it.displayName}>
                <div className="kf-rvc__desc">
                  {/* Always clickable - item details are viewable even
                     before the ingredient exists. The DetailPanel handles
                     the ingredient=null case by hiding the edit block
                     and showing a "create ingredient first" placeholder. */}
                  <button
                    type="button"
                    className="kf-cell-ellipsis kf-rvc__row-btn"
                    onClick={() => setPanelOpen({ kind: "item", itemId: it.id })}
                    title={`Open details for ${it.displayName}`}
                  >
                    {it.displayName}
                  </button>
                  {it.catchWeight ? (
                    <span className="kf-flag kf-flag--warn" title="Priced by actual weight">
                      <Scale size={14} strokeWidth={1.5} />
                    </span>
                  ) : null}
                </div>
                {it.displayNameSource === "catalog" && it.vendorOcrName !== it.displayName ? (
                  // Verbatim OCR identifier below the clean name - never
                  // Title-cased, always de-emphasized.
                  <div className="kf-rvc__ocrname" title="Vendor's invoice description (verbatim)">
                    {it.vendorOcrName}
                  </div>
                ) : null}
                {it.reason ? <div className="kf-rvc__reason">{it.reason}</div> : null}
              </td>
              <td>
                <div className="kf-cell-strong kf-cell-ellipsis">{it.vendor}</div>
                <div className="kf-cell-sub">{it.itemNumber ?? "none"}</div>
              </td>
              <td>
                <div className="kf-cell-ellipsis">
                  {it.packNormalized ?? it.pack ?? "-"}
                  <span className="kf-muted"> / {it.billedUnit ?? "-"}</span>
                </div>
                {it.packSource === "override" ? (
                  <div className="kf-cell-sub kf-cell-sub--note">manually entered</div>
                ) : it.packSource === "catalog" ? (
                  <div className="kf-cell-sub">catalog</div>
                ) : it.packSource === "invoice" ? (
                  <div className="kf-cell-sub kf-cell-sub--dim">invoice</div>
                ) : null}
              </td>
              <td className="kf-table__num">
                <UnitPriceCell item={it} />
              </td>
              <td className="kf-table__num"><strong>${fmtUsdLong(it.usd12m).replace(/^\$/, "")}</strong></td>
              <td className="kf-table__num">{fmtCount(it.lines12m)}</td>
              <td>
                {it.accounts.length > 0 ? (
                  <SitePills codes={it.accounts} max={3} />
                ) : (
                  <span className="kf-muted">-</span>
                )}
              </td>
              <td>{it.lastSeen ? fmtDate(it.lastSeen) : "-"}</td>
              <td><ConfidenceChip c={it.confidence} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <ReviewActions
        kind={group.kind}
        currentIngredientId={group.ingredient?.id ?? null}
        proposedName={group.proposedName}
        proposedParent={group.proposedParent}
        ingredients={ingredients}
        checkedIds={checkedIds}
        checkedItems={checkedItemsPreview}
        checkedCount={checkedCount}
        memberCount={memberCount}
        onLeaveStart={startLeaveAnimation}
      />

      {leavingAll ? (
        <div className="kf-rvc__leaving-overlay" aria-live="polite" role="status">
          <Check size={28} strokeWidth={2} aria-hidden />
          <span>Confirmed. Leaving the queue.</span>
        </div>
      ) : null}

      <footer className="kf-rvc__foot">{footerLine}</footer>

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

function ConfidenceChip({ c }: { c: string | null }) {
  if (c === "high") return <span className="kf-pill kf-pill--good">High</span>;
  if (c === "med") return <span className="kf-pill kf-pill--info">Med</span>;
  if (c === "low") return <span className="kf-pill kf-pill--muted">Low</span>;
  return <span className="kf-pill kf-pill--muted">-</span>;
}

// Unit price. Precedence:
//   1. Backfilled per-base ($/lb, $/fl oz, $/each) when confidence is
//      high or low. High renders a quiet check chip; low renders an
//      amber "est." chip + the parse note on hover.
//   2. Catalog case price (list) when a catalog match exists.
//   3. Latest billed case price from pr_price_observations.
//   4. "- needs pack" when neither pack nor price is available.
// Never fabricates a per-unit; "none" confidence falls back to case
// price with a muted "per-unit: needs pack" sub-line.
function UnitPriceCell({ item }: { item: ReviewGroupItem }) {
  if (item.perBase != null && item.perBaseUom && item.perBaseConfidence) {
    const uomLower =
      item.perBaseUom === "LB" ? "lb" :
      item.perBaseUom === "FLOZ" ? "fl oz" :
      item.perBaseUom === "EA" ? "each" :
      item.perBaseUom.toLowerCase();
    const title =
      (item.perBaseConfidence === "override"
        ? "Human-attested override (structured)"
        : item.perBaseConfidence === "high"
          ? "Per-unit estimate from pack size + case price"
          : "Low-confidence estimate (range / catch-weight / soft parse)") +
      (item.perBaseNote ? ` - ${item.perBaseNote}` : "");
    return (
      <span title={title}>
        <strong>{fmtUsd(item.perBase)}</strong>
        <span className="kf-muted"> / {uomLower}</span>
        <br />
        {item.perBaseConfidence === "override" ? (
          <span className="kf-conf-chip kf-conf-chip--override">
            <Check size={10} strokeWidth={2.5} aria-hidden />
            override
          </span>
        ) : item.perBaseConfidence === "high" ? (
          <span className="kf-conf-chip kf-conf-chip--ok">
            <Check size={10} strokeWidth={2.5} aria-hidden />
            per-unit
          </span>
        ) : (
          <span className="kf-conf-chip kf-conf-chip--low">est.</span>
        )}
      </span>
    );
  }
  if (item.catalogPrice != null) {
    return (
      <span title="Catalog case price - per-unit needs pack normalization">
        <strong>{fmtUsd(item.catalogPrice)}</strong>
        <br />
        <span className="kf-cell-sub">catalog case</span>
        <br />
        <span className="kf-cell-sub kf-cell-sub--dim">per-unit: needs pack</span>
      </span>
    );
  }
  if (item.unitPrice != null) {
    return (
      <span title="Latest billed case price - per-unit needs pack normalization">
        <strong>{fmtUsd(item.unitPrice)}</strong>
        <span className="kf-muted"> /{item.unitPriceUnit ?? "unit"}</span>
        <br />
        <span className="kf-cell-sub kf-cell-sub--dim">billed, latest</span>
        <br />
        <span className="kf-cell-sub kf-cell-sub--dim">per-unit: needs pack</span>
      </span>
    );
  }
  return (
    <span className="kf-muted">
      -
      <br />
      <span className="kf-cell-sub kf-cell-sub--dim">needs pack</span>
    </span>
  );
}

// Site pills: render the item's account-code list as chips (e.g.
// STL-FL, TXR-AZ). When the list is longer than `max`, the extras
// collapse into a "+N" trailing pill. Account codes are stable short
// identifiers used across the KitchFix stack; shown verbatim.
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
