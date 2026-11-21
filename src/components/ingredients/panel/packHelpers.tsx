"use client";

// Shared pack-math helpers for the panel's pack editor + its sub-blocks.
// Lifted verbatim from DetailPanel.tsx in N7 commit 0. Numbers and
// shapes unchanged - the UOM_GROUPS / BILLED_UNIT_GROUPS lists, the
// uomToBase / ingredientBase* resolvers, displayPerBase, the band
// map, parsePackNormalized and fmtUsdCents all moved as-is.

import type { ReviewCardIngredient } from "../itemTypes";
import {
  canonicalFromBaseUnit,
  convertPer,
  DIM_BY_UOM,
  TO_BASE,
  BASE_BY_DIM,
  WEIGHT_UOMS,
  VOLUME_UOMS,
  uomLabel,
  type Dim,
  type BaseUom,
} from "@/lib/ingredients/pack";

// N6: the pack editor's UOM groups come from the shared vocabulary.
// CAN10 stays appended to Weight as a pack-editor-only unit (U1).
// Count options stay as-is (EA / CT / DZ / PC); the dropdown exists in
// the pack editor only.
export const UOM_GROUPS: Array<{ label: string; options: string[] }> = [
  { label: "Weight", options: [...WEIGHT_UOMS, "CAN10"] },
  { label: "Volume", options: [...VOLUME_UOMS] },
  { label: "Count", options: ["EA", "CT", "DZ", "PC"] },
];

// N6: local view onto the shared TO_BASE / DIM_BY_UOM / BASE_BY_DIM.
// Returns { base, factor } the same way the old UOM_TO_BASE did; the
// numbers come from pack.ts so this file can never drift from the
// server estimator. Null when the uom is unknown.
export function uomToBase(uom: string | null | undefined): { base: BaseUom; factor: number } | null {
  if (!uom) return null;
  const u = uom.toUpperCase();
  const dim = DIM_BY_UOM[u];
  const factor = TO_BASE[u];
  if (!dim || factor == null) return null;
  return { base: BASE_BY_DIM[dim], factor };
}

// N6 A1: one path for "what dimension + base uom does this ingredient
// cost in". Replaces INGREDIENT_BASE_TO_UOM, INGREDIENT_BASE_DIM, and
// INGREDIENT_BASE_UOM - all three were hand-written and all three
// collapsed any unit outside { lb, each, gal, dozen } to undefined /
// LB / each silently. The single path is:
//   canonicalFromBaseUnit(base_unit) -> DIM_BY_UOM -> BASE_BY_DIM
// Returns LB / FLOZ / EA; null when the ingredient has no base_unit
// yet (ai-new group that hasn't been created).
export function ingredientBaseUom(
  ingredient: { base_unit?: string | null } | null
): BaseUom | null {
  if (!ingredient) return null;
  const canon = canonicalFromBaseUnit(ingredient.base_unit ?? null);
  if (!canon) return null;
  const dim = DIM_BY_UOM[canon];
  if (!dim) return null;
  return BASE_BY_DIM[dim];
}

export function ingredientBaseDim(
  ingredient: { base_unit?: string | null } | null
): Dim | null {
  if (!ingredient) return null;
  const canon = canonicalFromBaseUnit(ingredient.base_unit ?? null);
  if (!canon) return null;
  return DIM_BY_UOM[canon] ?? null;
}

// Display label for the UOM dropdown. Delegates to shared uomLabel;
// renders CAN10 as "#10 can" and FLOZ as uppercase "FL OZ" in the
// pack-editor dropdown specifically (kept uppercase here to match the
// existing option-list visual register).
export function uomDisplay(u: string): string {
  if (u === "FLOZ") return "FL OZ";
  if (u === "CAN10") return "#10 can";
  return u;
}

// S5: convert a $-per-dim-base number into $-per-master-unit for the
// item panel's Result + Read-as rows. The master list already converts
// per_base -> master.base_unit for display (IngredientMasters.tsx via
// the same convertPer / canonicalFromBaseUnit helpers in pack.ts);
// without this, a gallon-costed master shows $298.75/gal while the
// item panel reads $2.33/fl oz for the same price, and the user
// reads it as "my edit did not take". Fallbacks:
//   - no linked ingredient         -> dim-base label (today's behavior)
//   - master base_unit not canonical -> dim-base label
//   - cross-dimension (verdict's "won't blend") -> dim-base label
// Only the LABEL and the DISPLAYED VALUE change here; nothing writes
// anywhere.
export function displayPerBase(
  perBaseInDim: number,
  dimBase: "LB" | "FLOZ" | "EA",
  ingredient: ReviewCardIngredient | null,
): { value: number; label: string } {
  if (!ingredient) return { value: perBaseInDim, label: uomLabel(dimBase) };
  const target = canonicalFromBaseUnit(ingredient.base_unit);
  if (!target) return { value: perBaseInDim, label: uomLabel(dimBase) };
  const converted = convertPer(perBaseInDim, dimBase, target);
  if (converted == null) return { value: perBaseInDim, label: uomLabel(dimBase) };
  return { value: converted, label: ingredient.base_unit };
}

// Billed unit = how the VENDOR charged for the line, which decides which
// price tier fires:
//   a base unit  -> Tier A / Tier B use the invoice price directly
//   a container  -> the case-price tier divides by the pack size
// A value the engine does not recognise falls through to the container
// branch silently and the item's price ends up divided by its pack.
// Mirrors BASE_BILLED in src/lib/intake.ts and normUom in pack.ts; the
// server re-validates against ALLOWED_BILLED_UNITS.
// N6: billed unit dropdown. Per-unit group now carries every weight +
// volume unit that estimate.ts Tier A prices natively via normUom +
// uomFactor. Mirrors ALLOWED_BILLED_UNITS in set-pack-override/route.ts
// and BASE_BILLED in intake.ts - the three lists share the same word
// list and are linked by a comment at each site.
export const BILLED_UNIT_GROUPS: { label: string; options: string[] }[] = [
  { label: "Priced per unit - price used as-is", options: [
    "lb", "oz", "g", "kg",
    "fl oz", "pt", "qt", "gallon", "l", "ml",
    "each", "count", "dozen",
  ] },
  { label: "Priced per container - price divided by pack", options: ["case", "bag", "box", "pack", "jar", "can", "other"] },
];

// T7 R2 item 6: the pack a person reads is the pack the PRICE
// uses, not the pack as written. The server writes a hand-set
// pack_override into pack_qty / pack_size / pack_uom directly, so
// those three fields always reflect the current state (override
// first, parsed second). The function below reads them, builds
// the same "{qty}/{size} {uom}" / "{size} {uom}" string the item
// panel's Pack fact uses, and falls back to the raw pack_text,
// then to a "pack not read" sentinel.
//
// This is the SAME precedence the item panel applies (through
// itemFacts.pack reading item.packNormalized ?? item.pack): one
// helper, two call sites, no drift.
export function packInUseText(args: {
  packQty: number | null;
  packSize: number | null;
  packUom: string | null;
  packText: string | null;
  catchWeight?: boolean;
}): { text: string; known: boolean; catchWeight: boolean } {
  const { packQty, packSize, packUom, packText } = args;
  const catchWeight = args.catchWeight === true;
  if (packQty != null && packSize != null && packUom) {
    const q = Number(packQty);
    const s = Number(packSize);
    if (Number.isFinite(q) && Number.isFinite(s) && q > 0 && s > 0) {
      const text = q === 1 ? `${s} ${packUom}` : `${q}/${s} ${packUom}`;
      return { text, known: true, catchWeight };
    }
  }
  if (packText && packText.trim().length > 0) {
    return { text: packText.trim(), known: true, catchWeight };
  }
  return { text: "Pack not read", known: false, catchWeight };
}

// Parse the server's packNormalized ("50 LB" or "6/1 LB") back into
// qty/size/uom so the "Read as" row can show the total conversion.
export function parsePackNormalized(
  s: string | null
): { qty: number; size: number; uom: string } | null {
  if (!s) return null;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*\/\s*)?(\d+(?:\.\d+)?)\s+([A-Z ]+)$/);
  if (!m) return null;
  const qty = m[1] ? Number(m[1]) : 1;
  const size = Number(m[2]);
  const uom = m[3].trim().toUpperCase().replace(/\s+/g, "");
  if (!Number.isFinite(qty) || !Number.isFinite(size) || qty <= 0 || size <= 0) return null;
  return { qty, size, uom };
}

// Hint from the Attention section to the pack chain: set a UOM,
// focus Qty, scroll the Result row into view. nonce changes on each
// click so the effect fires even when the UOM stays the same.
export type PackHint = { uom: string; nonce: number };

// $/base plausibility bands. Mirrors IngredientMasters.tsx:62-69 - a
// hit is a soft "look here", not a hard assertion. Kept local to keep
// S2's diff within DetailPanel + drawer.css per spec acceptance 7.
// If a third file needs this later, extract to a shared module in
// one commit.
export const PACK_BANDS: Record<string, { low: number; high: number }> = {
  LB: { low: 0.5, high: 100 },
  OZ: { low: 0.03, high: 6 },
  FLOZ: { low: 0.01, high: 5 },
  GAL: { low: 1, high: 200 },
  EA: { low: 0.1, high: 25 },
  DZ: { low: 1, high: 60 },
};

// Exact-cents currency for the Evidence Extended column. fmtUsd rounds
// to $5K at amounts >= $1000; fmtUsdLong rounds to the dollar. Neither
// lets a human check 273 x $21.44 against $4,504.50.
export function fmtUsdCents(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// T6 round 2 item 8c: the editor's save-decision logic lives here as
// a pure function the PackOverrideBlock AND the proof import. Previously
// the proof carried a "pure mirror" copy that passed when the editor
// itself was wrong. Now there is one source.
//
// Branching per T6 ruling 1 (see the save-table in the memo):
//   catch weight             -> [set-pack-override]
//   pack dirty, price = default -> [set-pack-override]
//   pack pristine, price shortcut -> [set-price-override, auto reason]
//   pack pristine, price typed    -> [set-price-override, note or default]
//   pack dirty, price dirty    -> [set-pack-override, set-price-override]
//
// The function is pure (no routes, no network). It emits the POST
// sequence as plain objects the editor + the proof both consume.

export type PackSaveState = {
  // facts the editor compares against
  itemId: string;
  // current editor state
  catchWeight: boolean;
  catchWeightChanged: boolean;
  packPristine: boolean;
  qty: number;
  size: number;
  uom: string;
  perLb: number;
  billedUnit: string;
  note: string;
  // price field: current value + default + source hint if from a
  // shortcut or matched-to-the-cent against a file price
  caseFieldVal: number | null;
  defaultCaseVal: number | null;
  caseFieldSrcLabel: "catalog" | "billed" | "avg" | "typed" | null;
};

export type PackSavePost =
  | {
      route: "/api/review/set-pack-override";
      body: {
        itemId: string;
        catchWeight: boolean;
        perLb?: number;
        qty?: number;
        size?: number;
        uom?: string;
        billedUnit: string | null;
        note: string | null;
      };
    }
  | {
      route: "/api/review/set-price-override";
      body: {
        itemId: string;
        perBase: number;
        baseUom: "LB" | "FLOZ" | "EA";
        reason: string;
      };
    };

export function moneyEqualToCent(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b;
  return Math.round(a * 100) === Math.round(b * 100);
}

export function priceReasonFor(
  srcLabel: PackSaveState["caseFieldSrcLabel"],
  caseVal: number,
  note: string,
): string {
  const n = note.trim();
  if (srcLabel === "typed" || srcLabel === null) {
    return n.length > 0 ? n : "Price typed in the pack editor";
  }
  const auto = `Costed from ${srcLabel} case price $${caseVal.toFixed(2)} instead of the default`;
  return n.length > 0 ? `${auto}. ${n}` : auto;
}

export function decidePackSave(state: PackSaveState): PackSavePost[] {
  const caseFieldChanged = !moneyEqualToCent(state.caseFieldVal, state.defaultCaseVal);
  const packDirty =
    !state.catchWeight && (!state.packPristine || state.catchWeightChanged);
  const note = state.note.trim();
  const billed = state.billedUnit.trim();

  // Branch 1: catch weight.
  if (state.catchWeight) {
    return [
      {
        route: "/api/review/set-pack-override",
        body: {
          itemId: state.itemId,
          catchWeight: true,
          perLb: state.perLb,
          billedUnit: billed || null,
          note: note || null,
        },
      },
    ];
  }

  function priceBody(): PackSavePost | null {
    if (state.caseFieldVal == null) return null;
    const b = uomToBase(state.uom);
    if (!b) return null;
    const total = state.qty * state.size * b.factor;
    if (!(total > 0)) return null;
    return {
      route: "/api/review/set-price-override",
      body: {
        itemId: state.itemId,
        perBase: state.caseFieldVal / total,
        baseUom: b.base,
        reason: priceReasonFor(state.caseFieldSrcLabel, state.caseFieldVal, note),
      },
    };
  }

  // Branch 2: price only.
  if (!packDirty && caseFieldChanged) {
    const price = priceBody();
    return price ? [price] : [];
  }

  // Branch 3 + 4: pack only.
  if (packDirty && !caseFieldChanged) {
    return [
      {
        route: "/api/review/set-pack-override",
        body: {
          itemId: state.itemId,
          catchWeight: false,
          qty: state.qty,
          size: state.size,
          uom: state.uom,
          billedUnit: billed || null,
          note: note || null,
        },
      },
    ];
  }

  // Branch 5: pack and price.
  if (packDirty && caseFieldChanged) {
    const price = priceBody();
    if (!price) return [];
    return [
      {
        route: "/api/review/set-pack-override",
        body: {
          itemId: state.itemId,
          catchWeight: false,
          qty: state.qty,
          size: state.size,
          uom: state.uom,
          billedUnit: billed || null,
          note: note || null,
        },
      },
      price,
    ];
  }

  return [];
}
