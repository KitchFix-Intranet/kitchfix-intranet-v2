"use client";

// Structured pack-override editor (Phase 1.8). Replaces the free-text
// single input. Captures qty/size/uom via typed inputs + a dropdown so
// every save has the fields the per-unit math needs; computes the live
// preview from the same base-unit table as the server (OVERRIDE_TO_BASE
// in estimate.ts; mirrored here for the client preview). On save,
// propagates to same-SKU twins.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

import { useEffect, useRef, useState } from "react";
import { fmtCount, fmtPackNumbersInText, fmtUsd } from "@/lib/fmt";
import { uomLabel } from "@/lib/ingredients/pack";
import { priceInUnit } from "@/lib/ingredients/measures";
import type { ReviewCardIngredient, ReviewGroupItem } from "../itemTypes";
import { SaveFlash } from "./SaveFlash";
import { postJson } from "./common";
import { useSaveWithRefresh } from "./useSaveWithRefresh";
import { useDirtyEditor } from "./dirty";
import {
  UOM_GROUPS,
  BILLED_UNIT_GROUPS,
  PACK_BANDS,
  uomToBase,
  ingredientBaseUom,
  uomDisplay,
  displayPerBase,
  parsePackNormalized,
  decidePackSave,
  type PackHint,
} from "./packHelpers";

// T4 §3: both save branches read a `twins` count off the response body.
// Bodies without a twins field read 0 which is the same answer the
// pre-T4 inline code produced ("no matching items").
function readTwins(d: unknown): number {
  if (d == null || typeof d !== "object") return 0;
  const rec = d as { twins?: unknown };
  if (typeof rec.twins === "number" && Number.isFinite(rec.twins)) return rec.twins;
  return 0;
}

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
  measures: measuresProp,
}: {
  item: ReviewGroupItem;
  ingredient: ReviewCardIngredient | null;
  hint: PackHint | null;
  onDone: () => void;
  // N8 §1f: Cancel closes the row when the caller is a panel row.
  onCancel?: () => void;
  // M2 §4B amendment 6: ingredient's measures so the verdict can
  // call priceInUnit instead of the same-dim check. When measures
  // are not passed, fall back to the same-dim gate (callers that
  // have not updated see the same behaviour as part 1).
  measures?: readonly { from_unit: string; qty: number; to_unit: string; source: string }[];
}) {
  // M2 §4B amendment 6: use the ingredient's measures to determine
  // whether the typed pack reaches the ingredient's base_unit. When
  // priceInUnit returns null for the typed pack, show the "needs a
  // measure" verdict; otherwise suppress it.
  const measuresForReach = measuresProp ?? (ingredient?.measures as typeof measuresProp) ?? [];
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
  // T4 §3: busy + savedAt + error from the shared hook. busy stays true
  // through POST + refresh so the Save primary reads "Saving..." while
  // the new number is still mid-flight; the success toast + release
  // fire together.
  const { save: runSave, busy, savedAt, error, clearError } = useSaveWithRefresh();
  const [lastTwins, setLastTwins] = useState<number | null>(null);

  // T6 item 5: the price field is now a single text input the user
  // can type or fill from a "Prices on file" shortcut, matching the
  // reference's vPackEditor(). State: caseFieldStr (typed value) +
  // caseSrcHint (null when typed, or the source name when the user
  // clicked a shortcut and has not edited after). The field opens
  // holding the case price the server would choose today (from
  // storedSrc, or the biggest-gap heuristic). Shortcuts fill it;
  // every other key clears caseSrcHint back to null.
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
  const storedSrc: "catalog" | "billed" | "avg" | null =
    item.caseSource === "catalog"
      ? "catalog"
      : item.caseSource === "billed"
        ? "billed"
        : item.caseSource != null && item.caseSource.startsWith("actuals_")
          ? "avg"
          : null;
  // Default source for the "no pick, server would choose" case.
  const defaultCaseSrc: "catalog" | "billed" | "avg" | null =
    storedSrc ??
    (bigGap ? "billed" : catalogV != null ? "catalog" : billedV != null ? "billed" : null);
  function valueForSrc(src: "catalog" | "billed" | "avg" | null): number | null {
    if (src === "catalog") return catalogV;
    if (src === "billed") return billedV;
    if (src === "avg") return avgV;
    return null;
  }
  const defaultCaseVal = valueForSrc(defaultCaseSrc);
  const defaultCaseFieldStr =
    defaultCaseVal != null ? defaultCaseVal.toFixed(2) : "";
  const [caseFieldStr, setCaseFieldStr] = useState<string>(defaultCaseFieldStr);
  const [caseSrcHint, setCaseSrcHint] = useState<"catalog" | "billed" | "avg" | null>(
    defaultCaseSrc,
  );
  function parseMoney(s: string): number | null {
    const trimmed = s.trim().replace(/^\$/, "").replace(/,/g, "");
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function moneyEqual(a: number | null, b: number | null): boolean {
    if (a == null || b == null) return a === b;
    return Math.round(a * 100) === Math.round(b * 100);
  }
  const caseFieldVal = parseMoney(caseFieldStr);

  // N7 commit 2 + T6 item 5: Cancel restores every editor draft to
  // its mount-time seed.
  function resetDrafts() {
    setCatchWeight(initialCatchWeight);
    setCatchWeightEdited(false);
    setQtyStr(initialQtyStr);
    setSizeStr(initialSizeStr);
    setUom(initialUomStr);
    setPerLbStr(initialPerLbStr);
    setBilledUnit(initialBilledUnit);
    setNote("");
    setCaseFieldStr(defaultCaseFieldStr);
    setCaseSrcHint(defaultCaseSrc);
    clearError();
    setLastTwins(null);
    setPartialPackSaved(false);
  }
  // T6 item 5: the "case price typed" check is to the cent. A user
  // who retypes the same number has changed nothing.
  const caseFieldChanged = !moneyEqual(caseFieldVal, defaultCaseVal);
  const dirty =
    catchWeight !== initialCatchWeight ||
    catchWeightEdited ||
    qtyStr !== initialQtyStr ||
    sizeStr !== initialSizeStr ||
    uom !== initialUomStr ||
    perLbStr !== initialPerLbStr ||
    billedUnit !== initialBilledUnit ||
    note.trim().length > 0 ||
    caseFieldChanged;
  useDirtyEditor(`pack-${item.id}`, dirty && !busy, resetDrafts);
  // T6 item 5: the preview uses the TYPED case price when there is one;
  // otherwise falls back to the file-source default. previewCasePrice.v
  // carries the number; previewCasePrice.src carries a source label
  // when the number came from a shortcut (or matches a shortcut to the
  // cent), else "typed".
  const previewCasePrice: { v: number; src: "catalog" | "billed" | "avg" | "typed" } | null =
    caseFieldVal != null
      ? (() => {
          // If the typed value equals one of the on-file prices to
          // the cent, label it as that source regardless of the
          // user's last click (so an edit that lands on catalog
          // reads "catalog" too).
          if (moneyEqual(caseFieldVal, catalogV)) return { v: caseFieldVal, src: "catalog" as const };
          if (moneyEqual(caseFieldVal, billedV)) return { v: caseFieldVal, src: "billed" as const };
          if (moneyEqual(caseFieldVal, avgV)) return { v: caseFieldVal, src: "avg" as const };
          return { v: caseFieldVal, src: "typed" as const };
        })()
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
  // price; the panel must agree with it on open. Typing a different
  // price into the field puts the chain into "what-if" mode and the
  // recomputed figure takes over - clearing the field back to the
  // default (or clicking the stored-source shortcut) restores the
  // stored figure. T6 item 5: the "caseFieldChanged" check replaces
  // round-1's caseSrc dropdown comparison.
  const chainPristine =
    !catchWeight &&
    packPristine &&
    !catchWeightEdited &&
    !caseFieldChanged;
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

  // T6 item 5: the price field counts as a change when the typed /
  // shortcut-filled value differs from the default money-to-the-cent.
  // The save path below reads this to decide pack-only, price-only,
  // or pack-then-price. Catch-weight path has no case-price field so
  // this check is irrelevant there.
  const caseFieldChangedNonCw = !catchWeight && caseFieldChanged;
  const catchWeightChanged = catchWeight !== (item.catchWeight ?? false);
  const readyToSave =
    (catchWeight
      ? perLbValid && !perLbPristine
      : qtyValid && sizeValid && uomToBase(uom) != null && (!packPristine || caseFieldChangedNonCw || catchWeightChanged));
  // T6 ruling 1 + round 2 item 3: when the second POST of a
  // pack-then-price run fails after the first succeeded, we leave
  // the editor open with the price still in the field and show
  // "The pack was saved. The price was not." followed by a cause.
  // The retry sends the price alone - we force packPristine in the
  // state we feed to decidePackSave on the next save, so only the
  // price POST fires. The retry does NOT re-post the pack.
  const [partialPackSaved, setPartialPackSaved] = useState(false);
  // T6 round 2 item 1: per-editor Esc ask. Replaces the half-done
  // tryCloseEditor that dropped typed work without asking.
  const [editorAskOpen, setEditorAskOpen] = useState(false);
  // T6 round 2 item 1: autofocus the first field on open. The
  // segmented control is the first focusable; after mount we focus
  // the first mode button so Enter + Tab + Esc all read as expected.
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Only on initial mount; hint-driven focus takes over below.
    if (!hint) firstFieldRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T6 ruling 1 + round 2 item 8c: the branching logic lives in
  // packHelpers::decidePackSave. The proof imports the SAME
  // function, so this editor and the proof can never drift.
  async function save() {
    if (busy || !readyToSave) return;
    setLastTwins(null);

    // Build the state + call the shared decision. When the user
    // skipped the price step (already landed; partial-fail retry),
    // we pretend the pack is pristine so decidePackSave picks the
    // price-only branch.
    const state = {
      itemId: item.id,
      catchWeight,
      catchWeightChanged,
      packPristine: partialPackSaved ? true : packPristine,
      qty,
      size,
      uom,
      perLb,
      billedUnit,
      note,
      caseFieldVal,
      defaultCaseVal,
      caseFieldSrcLabel: (previewCasePrice?.src ?? null) as "catalog" | "billed" | "avg" | "typed" | null,
    };
    const posts = decidePackSave(state);
    if (posts.length === 0) return;

    // One-POST branches: catch weight, pack only, price only.
    if (posts.length === 1) {
      const [p] = posts;
      const label =
        p.route === "/api/review/set-pack-override"
          ? "pack override"
          : "price override";
      await runSave({
        op: () => postJson(p.route, p.body as unknown as Record<string, unknown>),
        successMessage: (d) => {
          const twins = readTwins(d);
          setLastTwins(twins);
          return twins > 0
            ? `Saved: ${label} (applied to ${fmtCount(twins + 1)} matching items)`
            : `Saved: ${label}`;
        },
        onDone,
      });
      // T6 round 2 item 3: if we were retrying a partial-fail (pack
      // already saved) and the price just landed, clear the partial
      // state so a fresh press is a clean save.
      if (partialPackSaved) setPartialPackSaved(false);
      return;
    }

    // Two POSTs: pack, then price. If pack fails the pack-only
    // sentence surfaces; if price fails after pack, the partial
    // sentence + the cause show and the next Save sends only the
    // price (branch resolves to one POST on retry because
    // partialPackSaved=true forces packPristine in the state).
    const [packPost, pricePost] = posts;
    const packRes = await postJson(
      packPost.route,
      packPost.body as unknown as Record<string, unknown>,
    );
    if (!packRes.ok) {
      await runSave({
        op: async () => packRes,
        successMessage: () => "",
        onDone,
      });
      return;
    }
    const packTwins = readTwins(packRes.data);
    setPartialPackSaved(true);
    const priceRes = await runSave({
      op: () => postJson(pricePost.route, pricePost.body as unknown as Record<string, unknown>),
      successMessage: (d) => {
        const priceTwins = readTwins(d);
        const total = Math.max(packTwins, priceTwins);
        setLastTwins(total);
        return total > 0
          ? `Saved: pack and price override (applied to ${fmtCount(total + 1)} matching items)`
          : "Saved: pack and price override";
      },
      onDone,
    });
    if (priceRes.ok) {
      setPartialPackSaved(false);
    }
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
  // Display-side rounding only: the math above uses the raw parsed
  // qty/size; the printed string rounds long decimals (3+ dp) so the
  // Read-as line reads cleanly without changing any stored number.
  readAsBody = fmtPackNumbersInText(readAsBody);

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
      // M2 §4B amendment 6: show the "needs a measure" verdict only
      // when priceInUnit returns null for the typed pack. The typed
      // pack's base_uom is `enteredBase`; the ingredient's unit is
      // `ingredientBase`. A minimal item shape covers the
      // factor-only fallback path (no pack fields, so priceInUnit
      // takes the fallback that divides perBase by factor).
      const reachable = enteredBase && ingredientBase
        ? priceInUnit(
            {
              perBase: 1,
              baseUom: enteredBase,
              packQty: null,
              packSize: null,
              packUom: null,
              caseWeightLb: null,
            },
            ingredientBase,
            { measures: (measuresForReach ?? []) as Parameters<typeof priceInUnit>[2]["measures"] },
          ) != null
        : false;
      if (!reachable) {
        const ingBaseWord = ingredient.base_unit?.toLowerCase() ?? "its unit";
        verdict = {
          tone: "block",
          text: `${ingredient.name} is costed per ${ingBaseWord}. This pack needs a measure on the ingredient to reach it.`,
        };
      } else {
        verdict = {
          tone: "good",
          text: `Matches ${ingredient.name} - this item reaches the blend through the measure.`,
        };
      }
    }
  }

  // T6 round 2 item 1: Esc / Cancel ask first when the editor has
  // typed work. Discard resets every editor field + closes the
  // row; Keep editing stays put. Train 2's rule: typed work is
  // never dropped without an ask.
  function tryCloseEditor() {
    if (busy) return;
    if (dirty) {
      setEditorAskOpen(true);
      return;
    }
    if (onCancel) onCancel();
  }
  function discardAndClose() {
    resetDrafts();
    setEditorAskOpen(false);
    if (onCancel) onCancel();
  }
  return (
    <form
      className="kf-ipanel__editor"
      aria-label="Pack and price editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          tryCloseEditor();
        }
      }}
    >
      {/* N8 §1f: segmented mode toggle on the left, invoice-reads on
          the right, same baseline. */}
      <div className="kf-ipanel__editor-toprow">
      <div className="kf-ipanel__seg" role="group" aria-label="How it is sold">
        <button
          ref={firstFieldRef}
          type="button"
          className="kf-ipanel__seg-btn"
          aria-pressed={!catchWeight}
          onClick={() => { setCatchWeight(false); setCatchWeightEdited(true); }}
          disabled={busy}
        >
          Fixed pack
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

      {/* N8 §1f: Read as - ONE muted line. */}
      <div className="kf-ipanel__editor-read">
        <strong>{readAsLabel}:</strong> {readAsBody}
        {readAsLabel === "Could not read" && item.perBaseNote ? <> &mdash; {item.perBaseNote}</> : null}
      </div>

      {/* N8 §1f: Fields grid.
          Priced by case: 4-across Qty / Size / Unit / Billed by, then
          2-across Case price / Note.
          Catch weight: 2-across $/lb / Billed by, then Note full-width.
          Logic, state, options, writes unchanged from N7 commit 0. */}
      {catchWeight ? (
        <>
          <div className="kf-ipanel__editor-grid kf-ipanel__editor-grid--2">
            <label className="kf-ipanel__editor-field">
              Price per lb
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
            <label className="kf-ipanel__editor-field">
              That price is for
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
                      <option key={o} value={o}>one {o}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          <label className="kf-ipanel__editor-field">
            Note <small>optional</small>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. confirmed with vendor rep"
              disabled={busy}
            />
          </label>
        </>
      ) : (
        <>
          <div className="kf-ipanel__editor-grid kf-ipanel__editor-grid--4">
            <label className="kf-ipanel__editor-field">
              How many in a case
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
            <label className="kf-ipanel__editor-field">
              Size of each
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
            <label className="kf-ipanel__editor-field">
              Unit
              <select value={uom} onChange={(e) => setUom(e.target.value)} disabled={busy}>
                {UOM_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o} value={o}>{uomDisplay(o)}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="kf-ipanel__editor-field">
              That price is for
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
                      <option key={o} value={o}>one {o}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          {/* T6 item 5: "Price on the invoice" is a text input, not a
              select. It opens holding the case price in use today
              (defaultCaseFieldStr). A row of "Prices on file:"
              shortcut buttons below fills it with catalog / billed /
              avg values. Editing the field after a shortcut clears
              the hint so the auto-reason falls back to the typed
              phrase. */}
          <div className="kf-ipanel__editor-grid kf-ipanel__editor-grid--2">
            <label className="kf-ipanel__editor-field">
              Price on the invoice
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={caseFieldStr}
                onChange={(e) => {
                  setCaseFieldStr(e.target.value);
                  setCaseSrcHint(null);
                }}
                placeholder="e.g. 298.75"
                disabled={busy}
              />
            </label>
            <label className="kf-ipanel__editor-field">
              Note <small>optional</small>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. confirmed with vendor rep"
                disabled={busy}
              />
            </label>
          </div>
          {(catalogV != null || billedV != null || avgV != null) ? (
            <div className="kf-known">
              <span className="kf-word">Prices on file:</span>
              {catalogV != null ? (
                <button
                  type="button"
                  className="kf-rowlink"
                  onClick={() => {
                    setCaseFieldStr(catalogV.toFixed(2));
                    setCaseSrcHint("catalog");
                  }}
                  disabled={busy}
                >
                  catalog {fmtUsd(catalogV)}
                </button>
              ) : null}
              {billedV != null ? (
                <button
                  type="button"
                  className="kf-rowlink"
                  onClick={() => {
                    setCaseFieldStr(billedV.toFixed(2));
                    setCaseSrcHint("billed");
                  }}
                  disabled={busy}
                >
                  billed, latest invoice {fmtUsd(billedV)}
                </button>
              ) : null}
              {avgV != null ? (
                <button
                  type="button"
                  className="kf-rowlink"
                  onClick={() => {
                    setCaseFieldStr(avgV.toFixed(2));
                    setCaseSrcHint("avg");
                  }}
                  disabled={busy}
                >
                  invoice average {fmtUsd(avgV)}
                </button>
              ) : null}
            </div>
          ) : null}
          {bigGap ? (
            <div className="kf-ipanel__editor-foot">catalog and billed disagree by more than 25%</div>
          ) : null}
        </>
      )}

      {/* Dim verdict + band warning - full-width micro lines above the
          result band. Content unchanged from N7; only wrapper classes
          moved onto the editor shell. */}
      {verdict ? (
        <div className={`kf-pill kf-pill--${verdict.tone === "block" ? "block" : "good"}`} style={{ width: "fit-content" }}>
          {verdict.text}
        </div>
      ) : null}
      {outOfBand && pricePerUserUom != null && band && userUom ? (
        <div className="kf-pill kf-pill--warn" style={{ width: "fit-content" }}>
          {fmtUsd(pricePerUserUom)}/{userUom.toLowerCase()}{" "}
          is far outside the usual range for per-{userUom.toLowerCase()} ingredients.
          {bandCaseHint
            ? ` A case of ${bandCaseHint.n} would land at ${fmtUsd(bandCaseHint.perUnit)}/${userUom.toLowerCase()}.`
            : ""}
        </div>
      ) : null}

      {/* Result band - summary left, price right. */}
      <div ref={resultRef} className="kf-ipanel__editor-band">
        <div className="kf-ipanel__editor-band-l">
          <div className="kf-ipanel__editor-band-label">Result</div>
          <div className="kf-ipanel__editor-band-sum">{preview.line}</div>
        </div>
        <div className="kf-ipanel__editor-band-value">
          {preview.perBase != null ? (
            <>
              {fmtUsd(preview.perBase)}{" "}
              <span className="kf-ipanel__editor-band-value-unit">/ {preview.baseLabel ?? "unit"}</span>
            </>
          ) : (
            <span className="kf-ipanel__editor-band-value-unit">&mdash; / unit</span>
          )}
        </div>
      </div>

      {/* Price-set-by-hand micro - unchanged math, carried as a foot. */}
      {item.priceManualOverride && item.perBase != null &&
        (item.perBaseUom === "LB" || item.perBaseUom === "FLOZ" || item.perBaseUom === "EA") ? (() => {
          const disp = displayPerBase(item.perBase, item.perBaseUom, ingredient);
          return (
            <div className="kf-ipanel__editor-foot">
              Price set by hand - {fmtUsd(disp.value)} / {disp.label}
            </div>
          );
        })() : null}

      {/* T6 ruling 1 + round 2 item 3: the pack saved but the price
          did not. The editor stays open with the price in the field
          and the next press sends the price alone (decidePackSave
          picks the price-only branch because packPristine is forced
          true while partialPackSaved is set).
          The cause follows the server's vocabulary from
          saveErrorSentence; we strip the "Nothing was saved."
          tail it carries because it is false here: the pack HAS
          landed. */}
      {partialPackSaved && error ? (
        <div className="kf-ipanel__editor-foot" role="alert">
          The pack was saved. The price was not.
          {" "}
          {error
            .replace(/\.?\s*Nothing was saved\.?\s*$/i, ".")
            .trim()
            .replace(/\.$/, "")
            .concat(".")}
        </div>
      ) : null}

      {/* T6 round 2 item 1: per-editor Discard ask. Opens when Esc
          or Cancel is pressed with typed work. Discard resets fields
          + closes the row; Keep editing stays put with focus on
          Keep. Train 2's rule: typed work is never dropped by Esc,
          the close button, a click outside, or a step without this
          ask. */}
      {editorAskOpen ? (
        <div className="kf-ipanel__editor-ask" role="alertdialog" aria-label="Discard what you typed?">
          <span className="kf-ipanel__editor-ask-text">Discard what you typed?</span>
          <button
            type="button"
            className="kf-btn kf-btn--primary kf-btn--sm"
            autoFocus
            onClick={() => setEditorAskOpen(false)}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            onClick={discardAndClose}
          >
            Discard
          </button>
        </div>
      ) : null}

      {/* T6 item 5: Cancel + Save on one row. Save label follows the
          action: "Save price" for a price-only or pack-pristine save,
          "Save pack" for a pack-only save, "Save pack and price" when
          both. Submit type so Enter in any field saves. */}
      <div className="kf-ipanel__editor-actions">
        {/* T6 item 5: when Save is disabled, a short why-sentence
            reads beside it (reference words). "Nothing has changed
            yet." is the floor. */}
        {!busy && !readyToSave ? (
          <span className="kf-ipanel__editor-why">
            {!dirty
              ? "Nothing has changed yet."
              : catchWeight
                ? !perLbValid
                  ? "Enter a price per lb."
                  : "Nothing has changed yet."
                : !qtyValid
                  ? "Enter how many in a case."
                  : !sizeValid
                    ? "Enter the size of each."
                    : !uomToBase(uom)
                      ? "Pick a unit."
                      : "Nothing has changed yet."}
          </span>
        ) : null}
        <button
          type="button"
          className="kf-btn kf-btn--ghost kf-btn--sm"
          disabled={busy}
          onClick={tryCloseEditor}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={`kf-btn kf-btn--primary kf-btn--sm${busy ? " is-busy" : ""}`}
          disabled={busy || !readyToSave}
        >
          {busy
            ? "Saving..."
            : catchWeight
              ? "Save pack"
              : packPristine && !catchWeightChanged && caseFieldChanged
                ? "Save price"
                : caseFieldChanged
                  ? "Save pack and price"
                  : "Save pack"}
        </button>
        <SaveFlash savedAt={savedAt} error={partialPackSaved ? null : error} />
      </div>

      {lastTwins != null && lastTwins > 0 ? (
        <div className="kf-ipanel__editor-foot">
          Applied to <strong>{fmtCount(lastTwins + 1)}</strong> matching items (same vendor SKU).
        </div>
      ) : null}
      {item.gtin ? (
        <div className="kf-ipanel__editor-foot">GTIN {item.gtin}</div>
      ) : null}
    </form>
  );
}

// N6: this item's own each measure when its each is a different size
// than the master's average. qty + uom, any weight or volume. A
// checkbox reveals the inputs; unticking + Save clears both columns.
// The sentence under it goes through deriveRecipePrice (same math the
// headline uses) rather than a local division - that's the PR #21 P2
// fix in A1.
