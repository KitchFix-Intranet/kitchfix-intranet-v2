"use client";

// Structured pack-override editor (Phase 1.8). Replaces the free-text
// single input. Captures qty/size/uom via typed inputs + a dropdown so
// every save has the fields the per-unit math needs; computes the live
// preview from the same base-unit table as the server (OVERRIDE_TO_BASE
// in estimate.ts; mirrored here for the client preview). On save,
// propagates to same-SKU twins.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { convertPer, uomLabel } from "@/lib/ingredients/pack";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson, errMsg } from "./common";
import {
  UOM_GROUPS,
  BILLED_UNIT_GROUPS,
  PACK_BANDS,
  uomToBase,
  ingredientBaseUom,
  uomDisplay,
  displayPerBase,
  parsePackNormalized,
  type PackHint,
} from "./packHelpers";

// N8 §1f + DESIGN.md 11: plain phrase for every item.caseSource value.
function caseSourcePhrase(src: string | null): string {
  if (src === "catalog") return "the catalog price";
  if (src === "billed") return "the billed price on the last invoice";
  if (src === "actuals_case") return "the average case paid";
  if (src === "actuals_unit") return "the average per-unit paid";
  if (src === "actuals_blended") return "the blended average paid";
  if (src === "override") return "the override you set";
  return "the stored estimate";
}

export function PackOverrideBlock({
  item,
  ingredient,
  hint,
  onCancel,
  onDone,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  hint: PackHint | null;
  onDone: () => void;
  // N8 §1f: Cancel closes the row when the caller is a panel row.
  onCancel?: () => void;
}) {
  // S2: pre-fill qty/size/uom from the item's own stored pack so
  // correcting one field is one keystroke, not a retype. When
  // packNormalized does not parse, fields stay blank.
  const seededPack = parsePackNormalized(item.packNormalized);
  // U1: when the parser tagged this item as a #10 can (raw pack text
  // carries "#10"), pre-select "#10 can" as the Change-to UOM so the
  // common fix is one confirm. qty + size come from seededPack
  // unchanged - the parser already emits qty=caseCount, size=1 for
  // these - we only swap the uom from the parser's symbolic "CT" to
  // the weight-dimension CAN10 so the Result math produces $/lb.
  // UI suggestion only: no stored data is rewritten; the user still
  // has to confirm.
  const can10Hint = /#10\b/.test(item.pack ?? "");
  // N7 commit 2: initial drafts captured here so Cancel can restore.
  const initialCatchWeight = item.catchWeight;
  const initialQtyStr = seededPack ? String(seededPack.qty) : "";
  const initialSizeStr = seededPack ? String(seededPack.size) : "";
  const initialUomStr = can10Hint
    ? "CAN10"
    : seededPack?.uom && uomToBase(seededPack.uom)
      ? seededPack.uom
      : "LB";
  const [catchWeight, setCatchWeight] = useState<boolean>(initialCatchWeight);
  // S4: tracks whether the user has toggled the mode button. Toggling
  // is an edit for display purposes (the chain switches to recomputed
  // from a different formula), so it must flip showStored off.
  const [catchWeightEdited, setCatchWeightEdited] = useState<boolean>(false);
  const [qtyStr, setQtyStr] = useState<string>(initialQtyStr);
  const [sizeStr, setSizeStr] = useState<string>(initialSizeStr);
  const [uom, setUom] = useState<string>(initialUomStr);
  const qtyInputRef = useRef<HTMLInputElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  // Fix-the-pack hint from Attention: set UOM, focus Qty, scroll
  // Result into view. Does NOT prefill qty/size - the user supplies
  // the number. nonce avoids stale-closure skips.
  useEffect(() => {
    if (!hint) return;
    setCatchWeight(false);
    setCatchWeightEdited(true);
    setUom(hint.uom);
    qtyInputRef.current?.focus();
    resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [hint?.nonce, hint?.uom]);
  // Display seed only: two decimals, like every other money field. What
  // the user types is what saves - this does not touch the write.
  const initialPerLbStr =
    item.perBase != null && item.catchWeight ? Number(item.perBase).toFixed(2) : "";
  const initialBilledUnit = item.billedUnit ?? "";
  const [perLbStr, setPerLbStr] = useState<string>(initialPerLbStr);
  const [billedUnit, setBilledUnit] = useState<string>(initialBilledUnit);
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTwins, setLastTwins] = useState<number | null>(null);

  // S4: case-price source. Three options now (catalog, billed, avg)
  // and the default is the source that produced the stored per_base,
  // not the S2 ">25% disagreement" rule. When the stored source is an
  // averaged tier (actuals_*), surface the engine's case figure as an
  // "invoice average" option so the dropdown can honestly reproduce
  // the saved price. Falls back to the S2 bigGap heuristic only when
  // the item has no stored source (new / unpriced).
  const catalogV =
    item.catalogPrice != null && item.catalogPrice > 0 ? item.catalogPrice : null;
  const billedV = item.unitPrice != null && item.unitPrice > 0 ? item.unitPrice : null;
  const avgV =
    item.caseSource != null && item.caseSource.startsWith("actuals_") &&
    item.storedCasePrice != null && item.storedCasePrice > 0
      ? item.storedCasePrice
      : null;
  const bigGap =
    catalogV != null && billedV != null
      ? Math.abs(catalogV - billedV) / Math.max(catalogV, billedV) > 0.25
      : false;
  // Which source produced the stored per_base? Used both to default
  // the dropdown and to decide whether the Result row shows the
  // stored figure (showStored below).
  const storedSrc: "catalog" | "billed" | "avg" | null =
    item.caseSource === "catalog"
      ? "catalog"
      : item.caseSource === "billed"
        ? "billed"
        : item.caseSource != null && item.caseSource.startsWith("actuals_")
          ? "avg"
          : null;
  const defaultCaseSrc: "catalog" | "billed" | "avg" | null =
    storedSrc ??
    (bigGap ? "billed" : catalogV != null ? "catalog" : billedV != null ? "billed" : null);
  const initialCaseSrc = defaultCaseSrc;
  const [caseSrc, setCaseSrc] = useState<"catalog" | "billed" | "avg" | null>(initialCaseSrc);

  // N7 commit 2: Cancel restores every editor draft to its mount-time
  // seed. Catch-weight mode, pack qty/size/uom, perLb display, billed
  // unit, case-price source, note, and the catchWeightEdited flag all
  // snap back. Error + lastTwins also clear so the surface reads fresh.
  function resetDrafts() {
    setCatchWeight(initialCatchWeight);
    setCatchWeightEdited(false);
    setQtyStr(initialQtyStr);
    setSizeStr(initialSizeStr);
    setUom(initialUomStr);
    setPerLbStr(initialPerLbStr);
    setBilledUnit(initialBilledUnit);
    setNote("");
    setCaseSrc(initialCaseSrc);
    setError(null);
    setLastTwins(null);
  }
  const dirty =
    catchWeight !== initialCatchWeight ||
    catchWeightEdited ||
    qtyStr !== initialQtyStr ||
    sizeStr !== initialSizeStr ||
    uom !== initialUomStr ||
    perLbStr !== initialPerLbStr ||
    billedUnit !== initialBilledUnit ||
    note.trim().length > 0 ||
    caseSrc !== initialCaseSrc;
  const previewCasePrice =
    caseSrc === "catalog" && catalogV != null
      ? { v: catalogV, src: "catalog" as const }
      : caseSrc === "billed" && billedV != null
        ? { v: billedV, src: "billed" as const }
        : caseSrc === "avg" && avgV != null
          ? { v: avgV, src: "avg" as const }
          : catalogV != null
            ? { v: catalogV, src: "catalog" as const }
            : billedV != null
              ? { v: billedV, src: "billed" as const }
              : avgV != null
                ? { v: avgV, src: "avg" as const }
                : null;

  const qty = Number(qtyStr);
  const size = Number(sizeStr);
  const perLb = Number(perLbStr);
  const qtyValid = Number.isFinite(qty) && qty > 0;
  const sizeValid = Number.isFinite(size) && size > 0;
  const perLbValid = Number.isFinite(perLb) && perLb > 0;

  // Pristine check: the entered pack still equals the stored one.
  // Save pack stays disabled when nothing has changed so pre-filling
  // never writes an unchanged pack back as a human-set override.
  const packPristine =
    !!seededPack &&
    qtyValid &&
    sizeValid &&
    Number(seededPack.qty) === qty &&
    Number(seededPack.size) === size &&
    seededPack.uom === uom;
  const perLbPristine =
    item.perBase != null &&
    item.catchWeight &&
    perLbValid &&
    Math.abs(Number(item.perBase) - perLb) < 0.005;

  // S4: show the item's SAVED per_base in the Result row (and the
  // Read-as derived tail, and the band check) when nothing has moved
  // yet - pack inputs are at their seeded values, the mode has not
  // been toggled, and the case-price dropdown is still on the source
  // that produced the stored price. The master list reads the stored
  // price; the panel must agree with it on open. Rotating the
  // dropdown to a different source puts the chain into "what-if"
  // mode and the recomputed figure takes over - rotating back to the
  // stored source restores the stored figure.
  const chainPristine =
    !catchWeight &&
    packPristine &&
    !catchWeightEdited &&
    caseSrc === storedSrc;
  const showStored =
    chainPristine &&
    item.perBase != null &&
    item.perBaseUom != null;

  // Live preview math - mirrors estimateFromOverride for a client-side
  // display BEFORE the save; the server re-does the math from the same
  // table so there's no drift risk.
  let preview: { line: string; dim: string | null; perBase: number | null; baseLabel: string | null } = {
    line: "",
    dim: null,
    perBase: null,
    baseLabel: null,
  };
  if (catchWeight) {
    if (perLbValid) {
      // Catch-weight is weight-dim; displayPerBase converts LB ->
      // ingredient.base_unit when linked (lb master is a no-op; cross
      // dim is impossible in practice because catch-weight only exists
      // on meat/produce, but the helper falls back cleanly).
      const disp = displayPerBase(perLb, "LB", ingredient);
      preview = {
        line: `${fmtUsd(disp.value)} / ${disp.label} (catch-weight)`,
        dim: "weight",
        perBase: disp.value,
        baseLabel: disp.label,
      };
    } else {
      preview = { line: "enter $/lb to preview", dim: null, perBase: null, baseLabel: null };
    }
  } else {
    if (qtyValid && sizeValid && uom && uomToBase(uom)) {
      const b = uomToBase(uom)!;
      const total = qty * size * b.factor;
      if (previewCasePrice) {
        // Compute perBase in the DIMENSION base (what the backfill
        // writes to price_estimate.per_base and what the server stamps
        // on save), then convert for DISPLAY only. The pack-total
        // echo on the left of "->" stays in the dim-base unit because
        // it is a math echo of the pack ("6 x 1 GAL = 768.00 fl oz"),
        // not a price display.
        const perBaseInDim = previewCasePrice.v / total;
        const disp = displayPerBase(perBaseInDim, b.base, ingredient);
        preview = {
          line: `${qty} x ${size} ${uomDisplay(uom)} = ${total.toFixed(2)} ${uomLabel(b.base)} -> ${fmtUsd(disp.value)} / ${disp.label}  (case ${fmtUsd(previewCasePrice.v)} ${previewCasePrice.src})`,
          dim: "math",
          perBase: disp.value,
          baseLabel: disp.label,
        };
      } else {
        preview = {
          line: `${qty} x ${size} ${uomDisplay(uom)} = ${total.toFixed(2)} ${uomLabel(b.base)}  (no case price on file - per-unit will be blank)`,
          dim: "no-price",
          perBase: null,
          baseLabel: uomLabel(b.base),
        };
      }
    } else {
      preview = { line: "enter qty / size / uom to preview", dim: null, perBase: null, baseLabel: null };
    }
  }

  // S4 + S5: on pristine open override preview.perBase with the item's
  // SAVED per_base, converted to the MASTER's unit via displayPerBase
  // so the headline reads $/gal (lb/each/dozen) and agrees with the
  // master list. Without the conversion S4 would re-introduce the
  // "$2.33 / fl oz" display S5 fixed. The sub tag says "saved" so the
  // user knows this isn't a recomputation. storedBaseLabel is kept as
  // the dim-base fallback for items that are unlinked or whose
  // perBaseUom isn't one of the three canonical bases.
  const storedBaseLabel =
    item.perBaseUom === "LB"
      ? "lb"
      : item.perBaseUom === "FLOZ"
        ? "fl oz"
        : item.perBaseUom === "EA"
          ? "each"
          : item.perBaseUom?.toLowerCase() ?? null;
  if (showStored && item.perBase != null && storedBaseLabel != null && seededPack) {
    const packStr =
      seededPack.qty === 1
        ? `${seededPack.size} ${seededPack.uom}`
        : `${seededPack.qty} x ${seededPack.size} ${seededPack.uom}`;
    const canonical =
      item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA"
        ? displayPerBase(item.perBase, item.perBaseUom, ingredient)
        : { value: item.perBase, label: storedBaseLabel };
    preview = {
      // N8 §1f: DESIGN.md 11 - no raw enum in UI. Every caseSource gets
      // a plain phrase.
      line: `${packStr} - saved per-unit from ${caseSourcePhrase(item.caseSource)}`,
      dim: "math",
      perBase: canonical.value,
      baseLabel: canonical.label,
    };
  }

  // S2: band check on the price per the USER's chosen uom - not the
  // normalized base. Avocado-oil 1x1 GAL at $298.75 normalizes to
  // $2.33/fl oz which falls inside the FLOZ band; it is $298.75/gal
  // which falls outside the GAL band. The user is thinking in gallons,
  // so we band in gallons. Soft warning only, no save-block.
  //
  // S4: on pristine open, band-check the stored price (converted into
  // the user's declared uom) rather than a recomputed hypothetical.
  // Out-of-band saves should fire the warning on open too.
  const userUom = catchWeight ? "LB" : uom && uomToBase(uom) ? uom : null;
  const band = userUom ? PACK_BANDS[userUom] : null;
  let pricePerUserUom: number | null = catchWeight
    ? perLbValid ? perLb : null
    : qtyValid && sizeValid && previewCasePrice
      ? previewCasePrice.v / (qty * size)
      : null;
  if (showStored && item.perBase != null && userUom) {
    const b = uomToBase(userUom);
    if (b) pricePerUserUom = item.perBase * b.factor;
  }
  const outOfBand =
    pricePerUserUom != null && band != null &&
    (pricePerUserUom < band.low || pricePerUserUom > band.high);
  // Suggest a "case of N" fix. Try common case sizes first (6, 4, 12,
  // 2, 24, 3, 8) because N=2 lands "in band" trivially for anything
  // just-over the band; the common sizes are more likely to be what
  // OCR actually dropped. The 6/1 GAL avocado oil must suggest 6,
  // not 2.
  const COMMON_CASE_SIZES = [6, 4, 12, 2, 24, 3, 8, 5, 10];
  let bandCaseHint: { n: number; perUnit: number } | null = null;
  if (outOfBand && pricePerUserUom != null && band) {
    for (const n of COMMON_CASE_SIZES) {
      const candidate = pricePerUserUom / n;
      if (candidate >= band.low && candidate <= band.high) {
        bandCaseHint = { n, perUnit: candidate };
        break;
      }
    }
  }

  // S6: moving the Case-price dropdown counts as a change, so a user
  // who ONLY picks "billed" (keeping the pack) can save. The save
  // routes to the A2.1 price-override path in save() below (durable;
  // the backfill skips pack_override.price_only). Catch-weight path
  // is unchanged - it has no case-price dropdown.
  const caseSrcChanged = caseSrc !== defaultCaseSrc;
  // S7: flipping the mode toggle counts as a change too. Shrimp live
  // example: fixed 4x5 LB case stored catch_weight=true, so the
  // catch-weight tier wrote the case total ($172.99) as $/lb. Flip
  // to "priced by the case" with no other edit must save and re-cost
  // via the normal pack path (172.99 / 20 = $8.65/lb). Compare
  // against item.catchWeight so toggling off then back on nets to
  // "no change" and leaves Save disabled.
  const catchWeightChanged = catchWeight !== (item.catchWeight ?? false);
  const readyToSave =
    (catchWeight
      ? perLbValid && !perLbPristine
      : qtyValid && sizeValid && uomToBase(uom) != null && (!packPristine || caseSrcChanged || catchWeightChanged));

  async function save() {
    if (busy || !readyToSave) return;
    setBusy(true);
    setError(null);
    setLastTwins(null);

    // S6: pack pristine + ONLY the case-price source moved -> write a
    // durable price override through A2.1's /set-price-override. This
    // is the branch where the user picked catalog-vs-billed in the
    // dropdown and clicked save; before S6 the pristine-pack check
    // would have left Save disabled, and even bypassing that the
    // pack-override route recomputes case price catalog-first and
    // discards the pick. Reuses setVendorItemPriceOverride (writes
    // pack_override.price_only, which the backfill skips). When the
    // user changed BOTH the pack and the case source, the pack
    // override wins - one save, one effect, no double-write.
    // S7: also skip when the toggle flipped - a mode change needs a
    // pack-override recompute (new tier), not a price pin. Same "one
    // save, one effect" rule.
    if (!catchWeight && packPristine && caseSrcChanged && !catchWeightChanged && previewCasePrice) {
      const b = uomToBase(uom)!;
      const total = qty * size * b.factor;
      const perBaseInDim = previewCasePrice.v / total;
      const srcLabel = previewCasePrice.src;
      const userNote = note.trim();
      const auto = `Costed from ${srcLabel} case price ${fmtUsd(previewCasePrice.v)} instead of the default`;
      const reason = userNote ? `${auto}. ${userNote}` : auto;
      const r = await postJson("/api/review/set-price-override", {
        itemId: item.id,
        perBase: perBaseInDim,
        baseUom: b.base,
        reason,
      });
      if (!r.ok) {
        const msg = errMsg(r.data, `Save failed (${r.status})`);
        setError(msg);
        toast(msg, { tone: "block" });
        setBusy(false);
        return;
      }
      const d = (r.data ?? {}) as { twins?: number };
      const twins = d.twins ?? 0;
      setLastTwins(twins);
      toast(
        twins > 0
          ? `Saved: price override (applied to ${fmtCount(twins + 1)} matching items)`
          : "Saved: price override"
      );
      setSavedAt(Date.now());
      setBusy(false);
      onDone();
      return;
    }

    const body: Record<string, unknown> = {
      itemId: item.id,
      catchWeight,
      billedUnit: billedUnit.trim() || null,
      note: note.trim() || null,
    };
    if (catchWeight) {
      body.perLb = perLb;
    } else {
      body.qty = qty;
      body.size = size;
      body.uom = uom;
    }
    const r = await postJson("/api/review/set-pack-override", body);
    if (!r.ok) {
      const msg = errMsg(r.data, `Save failed (${r.status})`);
      setError(msg);
      toast(msg, { tone: "block" });
      setBusy(false);
      return;
    }
    const d = (r.data ?? {}) as { twins?: number; perBase?: number | null };
    const twins = d.twins ?? 0;
    setLastTwins(twins);
    toast(
      twins > 0
        ? `Saved: pack override (applied to ${fmtCount(twins + 1)} matching items)`
        : "Saved: pack override"
    );
    setSavedAt(Date.now());
    setBusy(false);
    onDone();
  }

  // "Read as" row: dynamic label + body.
  // override         -> "Set by hand"
  // perBase=null+parse failed -> "Could not read" (with perBaseNote underneath when present)
  // otherwise        -> "Read as"
  const parsedBack = parsePackNormalized(item.packNormalized);
  const readAsLabel =
    item.packState === "override"
      ? "Set by hand"
      : item.perBase == null
        ? "Could not read"
        : "Read as";
  // S2: append the derived $/unit so the Read-as row answers the
  // question "is the existing pack already fine?". Uses the SAME
  // case-price source the Result row uses (previewCasePrice) so the
  // two numbers can be compared directly.
  let readAsBody: string;
  if (parsedBack) {
    const b = uomToBase(parsedBack.uom);
    const total = b ? parsedBack.qty * parsedBack.size * b.factor : null;
    const base = total != null && b
      ? parsedBack.qty === 1
        ? `${parsedBack.size} ${uomDisplay(parsedBack.uom)} = ${total.toFixed(2)} ${uomLabel(b.base)}`
        : `${parsedBack.qty} x ${parsedBack.size} ${uomDisplay(parsedBack.uom)} = ${total.toFixed(2)} ${uomLabel(b.base)}`
      : item.packNormalized ?? item.pack ?? "(not available)";
    // S4 + S5: showStored branch displays the item's stored per-unit
    // when the chain is pristine; the else branch recomputes from the
    // user's entry. BOTH branches route through displayPerBase so the
    // Read-as line reads in the MASTER's unit (gal/lb/each/dozen) and
    // agrees with the master list - without the conversion S4 would
    // re-introduce the "$2.33 / fl oz" display S5 fixed. The left
    // side of "->" stays in dim-base because it is a math echo of
    // the pack, not a price.
    let derived = "";
    if (
      showStored &&
      item.perBase != null &&
      (item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA")
    ) {
      const disp = displayPerBase(item.perBase, item.perBaseUom, ingredient);
      derived = ` -> ${fmtUsd(disp.value)} / ${disp.label}`;
    } else if (total != null && total > 0 && b && previewCasePrice) {
      const disp = displayPerBase(previewCasePrice.v / total, b.base, ingredient);
      derived = ` -> ${fmtUsd(disp.value)} / ${disp.label}`;
    } else if (total != null && b && !previewCasePrice) {
      derived = " -> no price";
    }
    readAsBody = base + derived;
  } else {
    readAsBody = item.packNormalized ?? item.pack ?? "(not available)";
  }

  // Result row: derived $/unit + verdict against the ingredient's base_unit.
  // N6 A1: resolve ingredient dimension and base uom through the shared
  // helpers so an `oz` or `qt` ingredient reaches the verdict correctly
  // (pre-N6 the hand map INGREDIENT_BASE_TO_UOM returned null and the
  // verdict silently didn't render). One path everywhere:
  // canonicalFromBaseUnit -> DIM_BY_UOM -> BASE_BY_DIM.
  const ingredientBase = ingredientBaseUom(ingredient);
  const enteredBase = catchWeight ? "LB" : uom && uomToBase(uom) ? uomToBase(uom)!.base : null;
  let verdict: { tone: "good" | "block"; text: string } | null = null;
  if (ingredient && ingredientBase && enteredBase && readyToSave) {
    if (enteredBase === ingredientBase) {
      verdict = {
        tone: "good",
        text: `Matches ${ingredient.name} - this item joins the blend.`,
      };
    } else {
      const baseWord =
        enteredBase === "LB" ? "lb" : enteredBase === "FLOZ" ? "fl oz" : "each";
      const ingBaseWord = ingredient.base_unit?.toLowerCase() ?? "its unit";
      verdict = {
        tone: "block",
        text: `${ingredient.name} is costed per ${ingBaseWord}. In ${baseWord} it still will not blend.`,
      };
    }
  }

  return (
    <div className="kf-ipanel__editor" aria-label="Pack and price editor">
      {/* N8 §1f: segmented mode toggle on the left, invoice-reads on
          the right, same baseline. */}
      <div className="kf-ipanel__editor-toprow">
      <div className="kf-ipanel__seg" role="group" aria-label="Pricing mode">
        <button
          type="button"
          className="kf-ipanel__seg-btn"
          aria-pressed={!catchWeight}
          onClick={() => { setCatchWeight(false); setCatchWeightEdited(true); }}
          disabled={busy}
        >
          Priced by the case
        </button>
        <button
          type="button"
          className="kf-ipanel__seg-btn"
          aria-pressed={catchWeight}
          onClick={() => { setCatchWeight(true); setCatchWeightEdited(true); }}
          disabled={busy}
        >
          Catch weight
        </button>
      </div>
        {item.pack ? (
          <div className="kf-ipanel__editor-read">Invoice reads &ldquo;{item.pack}&rdquo;</div>
        ) : null}
      </div>

      <div className="kf-chain">
        {/* Row 1 - Invoice says: verbatim pack text in a mono chip. */}
        <div className="kf-chain__row">
          <div className="kf-chain__label">Invoice says</div>
          <div className="kf-chain__value">
            <code className="kf-chain__mono">{item.pack ?? "(none)"}</code>
          </div>
        </div>

        {/* Row 2 - Read as / Set by hand / Could not read. */}
        <div className="kf-chain__row">
          <div className="kf-chain__label">{readAsLabel}</div>
          <div className="kf-chain__value">
            <span>{readAsBody}</span>
            {readAsLabel === "Could not read" && item.perBaseNote ? (
              <span className="kf-chain__sub">{item.perBaseNote}</span>
            ) : null}
          </div>
        </div>

        {/* Row 3 - Change to: inputs. Shape depends on mode. */}
        <div className="kf-chain__row kf-chain__row--input">
          <div className="kf-chain__label">Change to</div>
          <div className="kf-chain__value">
            {catchWeight ? (
              <div className="kf-dpn__row">
                <label className="kf-dpn__label">
                  <span>$ / lb</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={perLbStr}
                    onChange={(e) => setPerLbStr(e.target.value)}
                    placeholder="e.g. 5.299"
                    disabled={busy}
                  />
                </label>
              </div>
            ) : (
              <div className="kf-dpn__row kf-newing__row">
                <label className="kf-dpn__label">
                  <span>Qty</span>
                  <input
                    ref={qtyInputRef}
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min="0"
                    value={qtyStr}
                    onChange={(e) => setQtyStr(e.target.value)}
                    placeholder="e.g. 6"
                    disabled={busy}
                  />
                </label>
                <label className="kf-dpn__label">
                  <span>Size</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={sizeStr}
                    onChange={(e) => setSizeStr(e.target.value)}
                    placeholder="e.g. 5"
                    disabled={busy}
                  />
                </label>
                <label className="kf-dpn__label">
                  <span>UOM</span>
                  <select value={uom} onChange={(e) => setUom(e.target.value)} disabled={busy}>
                    {UOM_GROUPS.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.options.map((o) => (
                          <option key={o} value={o}>
                            {uomDisplay(o)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="kf-dpn__row kf-newing__row">
              <label className="kf-dpn__label">
                <span>Billed unit (optional)</span>
                <select
                  value={billedUnit}
                  onChange={(e) => setBilledUnit(e.target.value)}
                  disabled={busy}
                >
                  <option value="">(not set)</option>
                  {billedUnit !== "" &&
                    !BILLED_UNIT_GROUPS.some((g) => g.options.includes(billedUnit)) && (
                      <option value={billedUnit}>{billedUnit} (existing)</option>
                    )}
                  {BILLED_UNIT_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="kf-dpn__label">
                <span>Note (optional)</span>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. confirmed with vendor rep"
                  disabled={busy}
                />
              </label>
            </div>
            {!catchWeight ? (
              <div className="kf-chain__caseprice">
                <span className="kf-chain__caseprice-label">Case price</span>
                {(() => {
                  // S4: options come from whatever the item carries. The
                  // engine's own case figure ("invoice average") joins
                  // catalog and billed when the stored source was an
                  // actuals_* tier - without it the dropdown would hide
                  // the number that produced the saved per_base.
                  const options: Array<{ src: "catalog" | "billed" | "avg"; label: string; v: number }> = [];
                  if (catalogV != null) options.push({ src: "catalog", label: `${fmtUsd(catalogV)} - catalog`, v: catalogV });
                  if (billedV != null) options.push({ src: "billed", label: `${fmtUsd(billedV)} - billed, latest invoice line`, v: billedV });
                  if (avgV != null) options.push({ src: "avg", label: `${fmtUsd(avgV)} - invoice average`, v: avgV });
                  if (options.length >= 2) {
                    return (
                      <>
                        <select
                          className="kf-dt__unitsel"
                          value={caseSrc ?? options[0].src}
                          onChange={(e) =>
                            setCaseSrc(e.target.value as "catalog" | "billed" | "avg")
                          }
                          disabled={busy}
                        >
                          {options.map((o) => (
                            <option key={o.src} value={o.src}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {bigGap ? (
                          <span className="kf-chain__caseprice-note">
                            catalog and billed disagree by more than 25%
                          </span>
                        ) : null}
                      </>
                    );
                  }
                  if (options.length === 1) {
                    return <strong>{options[0].label}</strong>;
                  }
                  return <span className="kf-muted">none - pack will save, per-unit will be blank</span>;
                })()}
              </div>
            ) : null}
          </div>
        </div>

        {/* Row 4 - Result: derived $/unit + verdict. */}
        <div ref={resultRef} className="kf-chain__row kf-chain__row--result">
          <div className="kf-chain__label">Result</div>
          <div className="kf-chain__value">
            {preview.perBase != null ? (
              <strong className="kf-chain__big">
                {/* S4 + S5: label reads from preview.baseLabel, which
                    the preview-building block above sets to the
                    master's unit (via displayPerBase) in both the
                    showStored branch and the recompute branches. One
                    source of truth for the headline label. */}
                {fmtUsd(preview.perBase)} / {preview.baseLabel ?? "unit"}
              </strong>
            ) : (
              <strong className="kf-chain__big kf-muted">- / unit</strong>
            )}
            <span
              className={`kf-chain__sub${
                preview.dim === "no-price" ? " kf-chain__sub--warn" : ""
              }`}
            >
              {preview.line}
            </span>
            {/* The price is a separate fact from the pack. Key off the
                price flag directly - !packManualOverride suppressed
                this line on merged rows that had both (A2.2 fix).
                S5: convert the hand-set per_base into the master's
                unit via displayPerBase so this line agrees with the
                Result headline and the master list - without it the
                "set by hand" chip reads /fl oz on a gal master. */}
            {item.priceManualOverride && item.perBase != null && (item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA") ? (() => {
              const disp = displayPerBase(item.perBase, item.perBaseUom, ingredient);
              return (
                <span className="kf-chain__sub">
                  Price set by hand - {fmtUsd(disp.value)} / {disp.label}
                </span>
              );
            })() : null}
            {verdict ? (
              <span className={`kf-chain__verdict kf-chain__verdict--${verdict.tone}`}>
                {verdict.text}
              </span>
            ) : null}
            {outOfBand && pricePerUserUom != null && band && userUom ? (
              <span className="kf-chain__verdict kf-chain__verdict--warn">
                {fmtUsd(pricePerUserUom)}/{userUom.toLowerCase()}{" "}
                is far outside the usual range for per-{userUom.toLowerCase()} ingredients.
                {bandCaseHint
                  ? ` Check the pack - a case of ${bandCaseHint.n} would make this ${fmtUsd(bandCaseHint.perUnit)}/${userUom.toLowerCase()}.`
                  : " Check the pack."}
              </span>
            ) : null}
            <div className="kf-ipanel__editor-actions">
              <button
                type="button"
                className="kf-btn kf-btn--ghost kf-btn--sm"
                disabled={busy}
                onClick={() => {
                  if (dirty) resetDrafts();
                  if (onCancel) onCancel();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
                disabled={busy || !readyToSave}
                onClick={save}
              >
                {/* S6: label follows the action. Pack pristine + source
                    moved -> price-override write ("Save price"). Any
                    other save path ("Save pack") keeps today's label. */}
                {busy
                  ? "Saving..."
                  : !catchWeight && packPristine && caseSrcChanged && !catchWeightChanged
                    ? "Save price"
                    : "Save pack"}
              </button>
              <SaveFlash savedAt={savedAt} error={error} />
            </div>
            {lastTwins != null && lastTwins > 0 ? (
              <div className="kf-ipanel__editor-foot">
                Applied to <strong>{fmtCount(lastTwins + 1)}</strong> matching items (same vendor SKU).
              </div>
            ) : null}
          </div>
        </div>
        {/* N7 §3d: ItemEachMeasureBlock lifted OUT of the pack editor
            and promoted to its own row in PanelItemZone. */}
      </div>
      {item.gtin ? (
        <div className="kf-ipanel__editor-foot">GTIN {item.gtin}</div>
      ) : null}
    </div>
  );
}

// N6: this item's own each measure when its each is a different size
// than the master's average. qty + uom, any weight or volume. A
// checkbox reveals the inputs; unticking + Save clears both columns.
// The sentence under it goes through deriveRecipePrice (same math the
// headline uses) rather than a local division - that's the PR #21 P2
// fix in A1.
