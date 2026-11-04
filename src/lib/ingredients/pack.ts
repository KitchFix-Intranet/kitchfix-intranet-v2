// Pack-text parser. Pure function; no DB access, no side effects.
// Consumes a raw vendor pack string ("006/1# CS", "024/12OZ", "4/3 L",
// "15 DZN", "41#-90# AVERAGE PC", etc.) and returns a normalized shape
// plus a confidence rating. The normalizer never guesses when it can't
// identify both a count and a convertible unit; those return
// confidence='none' and a note so downstream code can render a
// "needs pack" state instead of a fabricated number.
//
// Phase 2 of step 5 will add an in-card quick-edit that writes a human
// pack_override; this phase just handles the machine-confident majority.

export type Dim = "weight" | "volume" | "count";
export type BaseUom = "LB" | "FLOZ" | "EA";
export type Confidence = "high" | "low" | "none";

export type ParsedPack = {
  qty: number | null;
  size: number | null;
  uom: string | null;
  dim: Dim | null;
  base_uom: BaseUom | null;
  // qty * size converted to base_uom. Null when parse failed or when the
  // unit is kept symbolically (e.g. #10 cans count as 1 each).
  total_base: number | null;
  confidence: Confidence;
  note: string | null;
};

const EMPTY: ParsedPack = {
  qty: null,
  size: null,
  uom: null,
  dim: null,
  base_uom: null,
  total_base: null,
  confidence: "none",
  note: null,
};

// U1: a #10 can's net weight for the pack-chain conversion. #10 is a
// standard food-service container; sauces, tomatoes, beans and the like
// come 6 cans to a case and a chef costs these per lb, not per can.
// 6.6 lb is the convention across the KitchFix basket (crushed tomatoes
// ~6.56, corn ~6.6, green beans ~6.3, sauce ~6.6). Picked over 7 lb for
// a slightly higher, more conservative $/lb - the safe side for food
// costing. Outliers (cranberry 7.3, drained beans ~4) are handled by
// the user switching to LB and typing the exact weight; this constant
// is not meant to cover them. One place to change if the basket shifts.
export const CAN10_LB_PER_UNIT = 6.6;

// Dimension and base-unit lookup for every canonical uom this parser
// may emit, PLUS CAN10 (U1) which the pack-chain UI emits for #10
// cans so a chef can cost sauces/beans/tomatoes per lb. CAN10 is not
// an invoice-text token - normUom does not recognise it - it reaches
// these tables only via the pack-chain dropdown and the override
// write path. "CT" and "PC" fall through to count/EA (treated as units).
export const DIM_BY_UOM: Record<string, Dim> = {
  LB: "weight", OZ: "weight", G: "weight", KG: "weight", CAN10: "weight",
  FLOZ: "volume", L: "volume", ML: "volume", GAL: "volume", QT: "volume", PT: "volume",
  CT: "count", DZ: "count", PC: "count", EA: "count",
};
export const BASE_BY_DIM: Record<Dim, BaseUom> = {
  weight: "LB",
  volume: "FLOZ",
  count: "EA",
};
// Multiply source-unit value by this to get the base unit.
export const TO_BASE: Record<string, number> = {
  // weight -> LB
  LB: 1,
  OZ: 1 / 16,
  G: 1 / 453.592,
  KG: 2.20462,
  CAN10: CAN10_LB_PER_UNIT,
  // volume -> FLOZ
  FLOZ: 1,
  L: 33.814,
  ML: 0.033814,
  GAL: 128,
  QT: 32,
  PT: 16,
  // count -> EA
  EA: 1,
  DZ: 12,
  CT: 1,
  PC: 1,
};

// Normalize a raw uom token into one of the canonical uoms above, or
// null if we don't recognize it. Case-insensitive; strips periods.
export function normUom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.toUpperCase().replace(/\./g, "").trim();
  if (!u) return null;
  if (/^LBS?$/.test(u)) return "LB";
  // LBA: common OCR typo for LB seen on real invoice data (step 5
  // Phase 1.6). Benign everywhere; LBA is not a legitimate unit.
  if (u === "LBA") return "LB";
  if (u === "#") return "LB";
  if (u === "OZ" || u === "OUNCE" || u === "OUNCES") return "OZ";
  // P1 §3.2: `Z` is a Sysco shorthand for OZ seen on real data
  // (`4Z`, `12/6Z`, `6x10 CSZ`). Not a standard SI symbol; Sysco-
  // vendor use only, benign everywhere - `Z` is not a legitimate
  // unit elsewhere in the invoice vocabulary.
  if (u === "Z") return "OZ";
  if (u === "G" || u === "GR" || u === "GRAM" || u === "GRAMS") return "G";
  if (u === "KG") return "KG";
  if (u === "L" || u === "LTR" || u === "LT" || u === "LITER" || u === "LITRE") return "L";
  if (u === "ML") return "ML";
  // FOZ: OCR-shortened "FL OZ" seen on real data. PT: pint (16 fl oz).
  if (u === "FLOZ" || u === "FO" || u === "FOZ" || u === "FL OZ" || u === "FLUID OZ") return "FLOZ";
  if (u === "PT" || u === "PINT" || u === "PINTS") return "PT";
  // GL is a common vendor shorthand for GAL (gallon). Added for the
  // Phase 1.5 slash-before-unit family (`4/1/GL`, `6/1/GL`).
  if (u === "GAL" || u === "GALLON" || u === "GALLONS" || u === "GL") return "GAL";
  if (u === "QT" || u === "QUART" || u === "QUARTS") return "QT";
  if (u === "DZ" || u === "DOZ" || u === "DZN" || u === "DOZEN") return "DZ";
  // CO: OCR-shortened CT (count), seen on real data.
  if (u === "CT" || u === "CNT" || u === "COUNT" || u === "CO") return "CT";
  if (u === "PC" || u === "PCS" || u === "PIECE" || u === "PIECES") return "PC";
  if (u === "EA" || u === "EACH") return "EA";
  return null;
}

function toBase(size: number, uom: string): { base_uom: BaseUom; total: number; dim: Dim } | null {
  const dim = DIM_BY_UOM[uom];
  if (!dim) return null;
  const factor = TO_BASE[uom];
  if (factor == null) return null;
  return { base_uom: BASE_BY_DIM[dim], dim, total: size * factor };
}

// Normalize a master's base_unit text ('lb', 'each', 'gal', 'dozen',
// 'POUND', ...) to one of our canonical uoms so convertPer / BANDS can
// key by it. Delegates to normUom() for the unit vocabulary; falls
// back to the few long-form spellings normUom doesn't yet carry.
// Lives here (not in the server-only IngredientMasters.tsx that
// originally owned it) so client surfaces - the item panel's Result /
// Read-as (S5) - can share the same lookup the master list uses.
export function canonicalFromBaseUnit(baseUnit: string | null): string | null {
  if (!baseUnit) return null;
  const u = baseUnit.toUpperCase().trim();
  const n = normUom(u);
  if (n) return n;
  if (u === "POUND" || u === "POUNDS") return "LB";
  if (u === "EACH") return "EA";
  if (u === "DOZEN") return "DZ";
  if (u === "GALLON") return "GAL";
  if (u === "LITER") return "L";
  if (u === "QUART") return "QT";
  if (u === "PINT") return "PT";
  if (u === "COUNT") return "CT";
  if (u === "PIECE") return "PC";
  return null;
}

// Convert a `$ per storedUom` value into `$ per targetUom`. Returns
// null when the two uoms are in different dimensions (unit mismatch -
// a strong "bad pack" signal; the master-list and the item-panel's
// verdict both treat that case as "won't blend"). The math is a
// factor ratio against TO_BASE: value * (TO_BASE[target] /
// TO_BASE[stored]). Verified byte-identical against the Bacon / Milk /
// Bottled-water baselines when the helper lived in IngredientMasters.
export function convertPer(
  value: number,
  storedUom: string | null | undefined,
  targetUom: string | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (!storedUom || !targetUom) return null;
  const su = storedUom.toUpperCase();
  const tu = targetUom.toUpperCase();
  if (su === tu) return value;
  const sf = TO_BASE[su];
  const tf = TO_BASE[tu];
  if (sf == null || tf == null) return null;
  if (DIM_BY_UOM[su] !== DIM_BY_UOM[tu]) return null;
  return value * (tf / sf);
}

// Trailing pack-container words we want to strip before parsing. Kept
// deliberately narrow so we don't eat a real unit; "PC" / "EA" are NOT
// in this list because they ARE units.
// Trailing pack-container words we strip before parsing. CA is a common
// OCR-truncated "CASE" seen on real data (step 5 Phase 1.6). "PC"/"EA"
// deliberately NOT here - they are units.
// P1 §3.7: expanded to include the packaging-descriptor words seen on
// real invoice data (SHK, WRAP, LAYER, CLAMSHELL, LOG, TRAY, BULK,
// PAC, PKS, INDV, EA) so a bare pack like "16 OZ SHK" matches "16 OZ"
// after the strip. These are never units; stripping them never loses
// information (pack_text itself keeps the full original string).
const TRAILING_CONTAINER = /\s+(CS|CA|CASE|BX|BOX|BG|BAG|PK|PKS|PACK|COV|TUB|JAR|CTN|CARTON|CAN|CANS|SHK|WRAP|LAYER|CLAMSHELL|LOG|TRAY|BULK|PAC|INDV|EA)\s*$/i;

// P1 §3.2 slashless 2-3 digit weight pack shape ("45 LB", "410 LB",
// "40#"). SHAPE ONLY - the parser does NOT downgrade these; a 25 LB
// sack of flour is not a slash-loss, and the shape alone is not
// evidence of OCR damage. The disagreement signal is CATALOG
// MISMATCH, not digit count (Kevin's P1 correction 2b, 2026-11-04).
// Exported so the backfill can detect the shape and, when a catalog
// SKU match disagrees with the invoice, mark the row `check` while
// taking the catalog's slashed form.
export const SLASHLESS_WEIGHT_RE = /^\s*\d{2,3}\s*(LB|LBS?|OZ|#)\s*$/i;

// P1: does the raw invoice pack text look like the slash-loss family?
// Used ONLY by the backfill's catalog-disagreement check. Does not
// imply the pack is wrong - only that a catalog SKU-match's slashed
// form, if different, is the better reading.
export function isSlashlessWeightPack(raw: string | null | undefined): boolean {
  if (!raw || typeof raw !== "string") return false;
  return SLASHLESS_WEIGHT_RE.test(raw.trim());
}

export function parsePack(raw: string | null | undefined): ParsedPack {
  if (!raw || typeof raw !== "string") return { ...EMPTY, note: "empty" };
  let s = raw.trim();
  if (!s) return { ...EMPTY, note: "empty" };

  s = s.toUpperCase().replace(/\s+/g, " ");
  // P1 §3.2: strip trailing punctuation (`.`, `,`, `;`) that otherwise
  // gets treated as non-benign trailing text and forces `none`. Seen
  // on `64 oz.`, `32 oz.`. This runs BEFORE TRAILING_CONTAINER so
  // "16 OZ SHK." becomes "16 OZ SHK" which then strips to "16 OZ".
  s = s.replace(/[.,;]+\s*$/g, "").trim();
  // P1 §3.7: strip leading "SQ" (square) prefix seen on real data
  // (`SQ 4OZ`, `SQ 2OZ`). Not a quantity or unit; a shape descriptor.
  s = s.replace(/^SQ\s+/, "").trim();
  // P1 §3.6: strip trailing descriptor glued to a `#` with no space
  // (`311#AVG` handled by trailingBenign; `3/8#INDV COV`, `40#BULK`,
  // `#PAC`, `#COV`). Narrow to the descriptor vocabulary so we don't
  // eat a real unit (nothing listed here is a legitimate unit).
  // AVG and UP are NOT in this list - they are catch-weight signals
  // the parser must preserve (see hasVaries below).
  s = s.replace(/#\s*(INDV|COV|BULK|PAC|CAB|BCH)\b[\s\S]*$/i, "#").trim();
  // P1 §3.7: normalise `N/M PKS` and `N/M PACK` (digit-glued or
  // space-separated). TRAILING_CONTAINER only strips space-delimited,
  // so `10/2pks` as a single token is handled here before fall-through.
  s = s.replace(/^(\d+\s*\/\s*\d+(?:\.\d+)?)\s*(?:PKS?|PACK)\s*$/i, "$1").trim();
  // P1 §3.7: trim pack-unit container words. Loop until no more
  // matches so doubled suffixes like `5 LB EA` -> `5 LB` -> `5 LB`
  // and `40# BULK PAC` -> `40# BULK` -> `40#` fully reduce. Bounded
  // to prevent any pathological infinite case (max 5 iters).
  for (let i = 0; i < 5; i += 1) {
    const stripped = s.replace(TRAILING_CONTAINER, "").trim();
    if (stripped === s) break;
    s = stripped;
  }
  // P1 §3.3: normalise `CT`/`DZ`/`PC`/`CN` suffix glued to a count
  // before a slash - `12CT/2.4 OZ` -> `12/2.4 OZ`. Strips the inner
  // count-unit marker so slashM reads the multi-pack cleanly.
  s = s.replace(/^(\d+)(?:CT|DZ|PC|CN)\s*\//i, "$1/");
  // P1 §3.3: multi-word `FL OZ` collapsed to `FLOZ` so the unit regex
  // `[A-Z#]+` catches it as one token. `6/48 FL OZ` -> `6/48 FLOZ`.
  s = s.replace(/\bFL\s+OZ\b/gi, "FLOZ");
  // P1 §3.3: `x` or `X` as a separator in "6x10 CSZ" is handled by
  // xSepM later - but "CSZ" is `CS`+`Z`, i.e. a CASE trailing-
  // container glued to a Z-for-OZ shorthand. Split it so Z is read.
  s = s.replace(/\bCSZ\b/g, "Z");

  // P1 §3.1: a solitary case-count like "1 CS" survives the strip
  // pass as just "1" (CS was eaten as a trailing container). Catch
  // the digit-only remainder BEFORE the match-nothing fallback so
  // these items read as a countable pack of N (size unknown), low
  // confidence, no per-base. Mirrors "case of N" semantics.
  const bareCaseM = s.match(/^(\d+)$/) && /\b(CS|CASE|BX|BOX|BG|BAG|CTN|CARTON)\b/i.test(raw);
  if (bareCaseM) {
    const n = parseInt(s, 10);
    if (n > 0 && n <= 1000) {
      return {
        qty: n,
        size: null,
        uom: null,
        dim: null,
        base_uom: null,
        total_base: null,
        confidence: "low",
        note: `${n} case${n === 1 ? "" : "s"}; inner size not stated`,
      };
    }
  }

  // Grade suffix early-reject. Meat grades glued to the pack
  // (`410-13#CAB`, `320#AVGBCH`, `215#AVGCABSHNT`, `89-11AVCAB`)
  // ambiguously mix pack text + grade; the range parser would
  // otherwise produce a midpoint that mixes a grade digit into the
  // weight. Return `none` so the review surface flags for a human.
  if (/(CAB|BCH|CABSHNT|AVCAB)$/.test(s)) {
    return { ...EMPTY, confidence: "none", note: `grade suffix detected: "${raw}"` };
  }

  // Catch-weight wording. UP (as in "65# UP") is added for Phase 1.6 -
  // real catch-weight invoices use "UP" alongside AVG. Word-bounded so
  // it doesn't catch "CUP", "UPGRADE", "GROUP", etc.
  const hasVaries = /\b(VARIES|AVERAGE|AVG|UP)\b/.test(s);
  const hasRange = /\d+\.?\d*\s*#?\s*[-–]\s*\d+/.test(s);

  // 1. #10 (or #N) can pattern: "006/#10 CS". qty is the outer count;
  // the inside is a labeled container we don't try to convert to
  // weight. Treat as plain count: qty eaches at 1 EA each.
  const canM = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*#(\d+)/);
  if (canM) {
    const qty = parseFloat(canM[1]);
    return {
      qty,
      size: 1,
      uom: "CT",
      dim: "count",
      base_uom: "EA",
      total_base: qty,
      confidence: "high",
      note: `#${canM[2]} can treated as count`,
    };
  }

  // 2. Range / average catch-weight.
  if (hasRange) {
    // 2a. Slash-prefixed range: "003/21-23 #", "004/11-14 # AVG",
    // "003/21-23 #". The qty before the slash is preserved; the inner
    // range gives a midpoint. This is a Phase 1.6 fix for the real
    // catch-weight shape - the general range branch below would lose
    // the qty prefix (qty=1 instead of 3/4).
    const slashRange = s.match(
      /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(#|[A-Z]+)?/
    );
    if (slashRange) {
      const qty = parseFloat(slashRange[1]);
      const a = parseFloat(slashRange[2]);
      const b = parseFloat(slashRange[3]);
      const uom = normUom(slashRange[4] ?? "#");
      if (uom != null) {
        const mid = (a + b) / 2;
        const conv = toBase(mid, uom);
        if (conv) {
          return {
            qty,
            size: mid,
            uom,
            dim: conv.dim,
            base_uom: conv.base_uom,
            total_base: qty * conv.total,
            confidence: "low",
            note: `catch-weight average; verify qty/size in review (range ${a}-${b} ${uom}, mid ${mid})`,
          };
        }
      }
    }

    // 2b. Bare range: "41#-90# AVERAGE PC", "8-12#", "2-3 LB".
    // Midpoint used; confidence low with a note.
    const r = s.match(
      /(\d+(?:\.\d+)?)\s*(#|[A-Z]+)?\s*[-–]\s*(\d+(?:\.\d+)?)\s*(#|[A-Z]+)?/
    );
    if (r) {
      const a = parseFloat(r[1]);
      const b = parseFloat(r[3]);
      const uom = normUom(r[4] ?? r[2] ?? null);
      if (uom != null) {
        const mid = (a + b) / 2;
        const conv = toBase(mid, uom);
        if (conv) {
          return {
            qty: 1,
            size: mid,
            uom,
            dim: conv.dim,
            base_uom: conv.base_uom,
            total_base: conv.total,
            confidence: "low",
            note: `range ${a}-${b} ${uom}; midpoint ${mid} used`,
          };
        }
      }
    }
    // Range detected but no uom - garbled. Return `none` (was `low`
    // with null fields in Phase 1.5; `none` is cleaner for the
    // backfill mapping and keeps `3-4 PBO` out of the per-unit tier).
    return {
      ...EMPTY,
      confidence: "none",
      note: `range detected but uom unclear: "${raw}"`,
    };
  }

  // P1 §3.5: three-level pack "9/12/2.12 OZ" = outer 9 x inner 12 x
  // size 2.12 OZ. The pack_qty / pack_size / pack_uom columns hold
  // only two levels, so flatten: qty = outer * inner, size = innermost
  // size, uom = innermost unit. total_base = qty * size * TO_BASE[uom]
  // is preserved - which is the only number downstream math reads.
  // Original shape stays in pack_text untouched. "6/4/12 BTL" falls
  // through here because BTL is not a unit; tripleSlashM below then
  // tries its unit-less path and the row ends up as check.
  const threeLevelM = s.match(
    /^(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*([A-Z#]+)/
  );
  if (threeLevelM) {
    const outer = parseInt(threeLevelM[1], 10);
    const inner = parseInt(threeLevelM[2], 10);
    const size = parseFloat(threeLevelM[3]);
    const uom = normUom(threeLevelM[4]);
    if (uom != null) {
      const conv = toBase(size, uom);
      if (conv) {
        const qty = outer * inner;
        return {
          qty,
          size,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: qty * conv.total,
          confidence: hasVaries ? "low" : "high",
          note: `three-level: ${outer} x ${inner} x ${size} ${uom}; flattened to qty=${qty}`,
        };
      }
    }
  }

  // 2b. Triple-slash slash-before-unit pattern: "2/5/LB", "4/1/GL",
  // "6/10/CN". Same semantics as the standard N/size UNIT but with an
  // explicit third segment. CN (can) is treated like a #10 can - the
  // inner "size" is ignored and the qty is the count of eaches.
  const tripleSlashM = s.match(
    /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*\/\s*([A-Z#]+)/
  );
  if (tripleSlashM) {
    const qty = parseFloat(tripleSlashM[1]);
    const size = parseFloat(tripleSlashM[2]);
    const uomRaw = tripleSlashM[3];
    if (uomRaw === "CN" || uomRaw === "CAN" || uomRaw === "CANS") {
      return {
        qty,
        size: 1,
        uom: "CT",
        dim: "count",
        base_uom: "EA",
        total_base: qty,
        confidence: "high",
        note: `${uomRaw} treated as count (inner size ${size} ignored)`,
      };
    }
    const uom = normUom(uomRaw);
    if (uom != null) {
      const conv = toBase(size, uom);
      if (conv) {
        return {
          qty,
          size,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: qty * conv.total,
          confidence: hasVaries ? "low" : "high",
          note: hasVaries ? "contains VARIES/AVERAGE wording" : null,
        };
      }
    }
  }

  // 2c. GFS-style "Units/Case" pattern: "4 Units/Case 5.0 LB",
  // "4 Units/Case 1.0 GAL". qty before "Units/Case", size+unit after.
  const unitsCaseM = s.match(
    /^(\d+)\s+UNITS?\/CASE\s+(\d+(?:\.\d+)?)\s*([A-Z#]+)/
  );
  if (unitsCaseM) {
    const qty = parseInt(unitsCaseM[1], 10);
    const size = parseFloat(unitsCaseM[2]);
    const uom = normUom(unitsCaseM[3]);
    if (uom != null) {
      const conv = toBase(size, uom);
      if (conv) {
        return {
          qty,
          size,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: qty * conv.total,
          confidence: hasVaries ? "low" : "high",
          note: hasVaries ? "contains VARIES/AVERAGE wording" : null,
        };
      }
    }
  }

  // 2d. x / X separator: "24x8 FOZ", "12X3CT", "6x3 CO", "12x6 LBA",
  // "8x10 LBA". Same semantics as the N/size UNIT slash form.
  // Placed before slashMatch so it doesn't collide with triple-slash.
  const xSepM = s.match(/^(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*([A-Z#]+)/);
  if (xSepM) {
    const qty = parseFloat(xSepM[1]);
    const size = parseFloat(xSepM[2]);
    const uom = normUom(xSepM[3]);
    if (uom != null) {
      const conv = toBase(size, uom);
      if (conv) {
        return {
          qty,
          size,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: qty * conv.total,
          confidence: hasVaries ? "low" : "high",
          note: hasVaries ? "contains VARIES/AVERAGE/UP wording" : null,
        };
      }
    }
  }

  // 3. Standard qty/size UNIT pattern: "6/1 LB", "024/12OZ",
  // "48/2.60 OZ", "4/3 L", "12/5.3 OZ".
  // P1 §3.3: size regex broadened to accept leading-decimal sizes
  // (`24/.6OZ`). The qty group is still integer-friendly; parseFloat
  // happily handles `024` leading zeros per §3.4.
  const slashM = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d*\.?\d+)\s*([A-Z#]+)/);
  if (slashM) {
    const qty = parseFloat(slashM[1]);
    const size = parseFloat(slashM[2]);
    const uom = normUom(slashM[3]);
    if (uom != null) {
      const conv = toBase(size, uom);
      if (conv) {
        return {
          qty,
          size,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: qty * conv.total,
          confidence: hasVaries ? "low" : "high",
          note: hasVaries ? "contains VARIES/AVERAGE wording" : null,
        };
      }
      return {
        qty,
        size,
        uom,
        dim: null,
        base_uom: null,
        total_base: null,
        confidence: "low",
        note: `uom ${uom} parsed but no base conversion`,
      };
    }
  }

  // Trailing text we tolerate on count/bare matches: catch-weight
  // variance words only. Anything else (notes like "WRAP", "DRY A",
  // "SAMPLE") suggests the string is a two-level pack / note that we
  // can't safely parse - fall through to `none`.
  const trailingBenign = (tail: string) =>
    tail.length === 0 || /^(AVG|AVERAGE|VARIES|UP)\b/.test(tail);

  // 4. Count-only pattern: "200 CT", "15 DZN", "2 PC", "30 COUNT".
  const countM = s.match(/^(\d+(?:\.\d+)?)\s*(DZ|DZN|DOZ|DOZEN|CT|CNT|COUNT|PC|PCS|PIECE|PIECES|EA|EACH)\b/);
  if (countM) {
    const tail = s.slice(countM[0].length).trim();
    if (!trailingBenign(tail)) {
      return {
        ...EMPTY,
        confidence: "none",
        note: `trailing text after count unit: "${raw}"`,
      };
    }
    const n = parseFloat(countM[1]);
    const uom = normUom(countM[2])!;
    const conv = toBase(n, uom)!;
    // Dozen guard: bare `N DZ` with N > 30 is almost always a dropped
    // separator (e.g. "115 DZ" is likely "1/15 DZ" or "15 DZ"), not
    // 115 real dozens. A real egg case is ~15 DZ. We keep the raw
    // parse (qty 1 x N DZ) but mark low + null total_base so the
    // backfill doesn't emit a confident wrong per-each from 1,380+ EA.
    // The row surfaces as `check` for human verification.
    if (uom === "DZ" && n > 30) {
      return {
        qty: 1,
        size: n,
        uom,
        dim: "count",
        base_uom: "EA",
        total_base: null,
        confidence: "low",
        note: `dozen count implausibly high (${n}); verify split`,
      };
    }
    return {
      qty: 1,
      size: n,
      uom,
      dim: "count",
      base_uom: "EA",
      total_base: conv.total,
      confidence: hasVaries ? "low" : "high",
      note: hasVaries ? "contains VARIES/AVERAGE/UP wording" : null,
    };
  }

  // P1 §3.3: space-as-separator "N M UNIT" - `1 10 LB` means qty 1,
  // size 10, uom LB. End-anchored to avoid colliding with the
  // doubled-unit spaceDoubleM below. Confidence stays high because the
  // unit is explicit; only the separator is unusual.
  const spaceSepM = s.match(
    /^(\d+)\s+(\d+(?:\.\d+)?)\s*([A-Z#]+)\s*$/
  );
  if (spaceSepM) {
    const qty = parseInt(spaceSepM[1], 10);
    const size = parseFloat(spaceSepM[2]);
    const uom = normUom(spaceSepM[3]);
    if (uom != null) {
      const conv = toBase(size, uom);
      if (conv) {
        return {
          qty,
          size,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: qty * conv.total,
          confidence: hasVaries ? "low" : "high",
          note: hasVaries ? "contains VARIES/AVERAGE/UP wording" : `space-separated pack; qty ${qty} x ${size} ${uom}`,
        };
      }
    }
  }

  // 5. Bare "N UNIT": "66 LB", "10 LB", "110#", "25 LBS", "50 LBS",
  // "43 L", "12.5 PT", "3210 OZ", "1210 FOZ".
  // P1 §3.2: broadened to accept leading-decimal numbers like `.5 GL`.
  const bareM = s.match(/^(\d*\.?\d+)\s*(#|[A-Z]+)/);
  if (bareM) {
    const bareTail = s.slice(bareM[0].length).trim();
    if (!trailingBenign(bareTail)) {
      return {
        ...EMPTY,
        confidence: "none",
        note: `trailing text after bare unit: "${raw}"`,
      };
    }
    const n = parseFloat(bareM[1]);
    const uom = normUom(bareM[2]);
    if (uom != null) {
      const conv = toBase(n, uom);
      if (conv) {
        // P1 correction 2b (2026-11-04): the parser does NOT downgrade
        // slashless 2-3 digit weights. A 25 LB sack of flour is not a
        // slash-loss, and the parser has no catalog visibility - shape
        // alone is not evidence. Catalog disagreement is checked in
        // the backfill via isSlashlessWeightPack() + a shape compare
        // against the SKU-matched catalog's parse. Measured impact of
        // nulling here (reverted): 340 items with a legitimate 2-3
        // digit weight and no catalog fallback would have lost their
        // per-base price.
        // Bare-N-large guard: a weight/volume >= 1000 bare integer
        // (`3210 OZ`, `1210 FOZ`) is almost always a dropped
        // separator - a real case rarely weighs that much in a single
        // uom tier. Mark low + null total_base so no confident
        // per-unit is emitted; the row surfaces as `check`. Count
        // units (CT, DZ, PC) are not downgraded here - large counts
        // (`1000 CT`) are legitimate.
        const isInt = Number.isInteger(n);
        const bulky = (conv.dim === "weight" || conv.dim === "volume") && isInt && n >= 1000;
        if (bulky) {
          return {
            qty: 1,
            size: n,
            uom,
            dim: conv.dim,
            base_uom: conv.base_uom,
            total_base: null,
            confidence: "low",
            note: `bare ${n} ${uom} implausibly large; verify split`,
          };
        }
        return {
          qty: 1,
          size: n,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: conv.total,
          confidence: hasVaries ? "low" : "high",
          note: hasVaries ? "contains VARIES/AVERAGE/UP wording" : null,
        };
      }
    }
  }

  // 7. Space-separated with a doubled trailing unit:
  //     "2 5 LB LB", "6 32 OZ OZ", "4 1 GAL GAL", "2 5LB LB".
  // The structure is: qty (int)  size (number, possibly glued to its
  // unit)  unit  unit, strictly end-anchored so garbled "4 3 L L"
  // kinds of inputs don't accidentally land here. Both units must be
  // >=2 chars - single-letter `L L` is intentionally rejected because
  // Phase 1 required `4 3 L L` to stay `none`. Confidence is 'low'
  // (space-separated pack is inferred, not explicit).
  const spaceDoubleM = s.match(
    /^(\d+)\s+(\d+(?:\.\d+)?)\s*([A-Z#]{2,})\s+([A-Z#]{2,})\s*$/
  );
  if (spaceDoubleM) {
    const uomA = normUom(spaceDoubleM[3]);
    const uomB = normUom(spaceDoubleM[4]);
    if (uomA != null && uomB != null && uomA === uomB) {
      const qty = parseInt(spaceDoubleM[1], 10);
      const size = parseFloat(spaceDoubleM[2]);
      const conv = toBase(size, uomA);
      if (conv) {
        return {
          qty,
          size,
          uom: uomA,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: qty * conv.total,
          confidence: "low",
          note: `space-separated pack; qty ${qty} x ${size} ${uomA} inferred`,
        };
      }
    }
  }

  // N/MPK S UNIT: "2/12PK 12OZ" = N outer x M inner x S UNIT.
  const multiPackM = s.match(
    /^(\d+)\s*\/\s*(\d+)\s*PK\s*(\d+(?:\.\d+)?)\s*([A-Z#]+)/
  );
  if (multiPackM) {
    const outer = parseInt(multiPackM[1], 10);
    const inner = parseInt(multiPackM[2], 10);
    const size = parseFloat(multiPackM[3]);
    const uom = normUom(multiPackM[4]);
    if (uom != null) {
      const conv = toBase(size, uom);
      if (conv) {
        return {
          qty: outer * inner,
          size,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: outer * inner * conv.total,
          confidence: hasVaries ? "low" : "high",
          note: `multipack ${outer} x ${inner} x ${size} ${uom}`,
        };
      }
    }
  }

  // Bare pack count: "12P", "30Pk", "12 PK". No inner size is given,
  // so this is a count of units, not a weight. 'low' on purpose.
  // Match against the pre-TRAILING_CONTAINER-strip form because PK is
  // in the trailing-container list ("12 PK" was being stripped to "12").
  const sPreStrip = raw.trim().toUpperCase().replace(/\s+/g, " ");
  const packCountM = sPreStrip.match(/^(\d+)\s*(?:PK|PACK|P)\s*$/);
  if (packCountM) {
    const n = parseInt(packCountM[1], 10);
    if (n > 0 && n <= 500) {
      return {
        qty: 1,
        size: n,
        uom: "CT",
        dim: "count",
        base_uom: "EA",
        total_base: n,
        confidence: "low",
        note: `pack count ${n}; unit size not stated`,
      };
    }
  }

  // Vendor prefix "ONLY" glued to a bare pack: "ONLY1 GAL", "ONLY5 LB".
  const onlyM = s.match(/^ONLY\s*(\d.*)$/);
  if (onlyM) {
    const inner = parsePack(onlyM[1]);
    if (inner.confidence !== "none") {
      return { ...inner, note: `"ONLY" prefix stripped; ${inner.note ?? "parsed"}` };
    }
  }

  // "Case of 6", "case of 24", "24/cs" - a count of units per case.
  const caseOfM = s.match(/^CASE\s+OF\s+(\d+)\s*$/) || s.match(/^(\d+)\s*\/\s*CS\s*$/);
  if (caseOfM) {
    const n = parseInt(caseOfM[1], 10);
    if (n > 0 && n <= 1000) {
      return {
        qty: 1, size: n, uom: "CT", dim: "count", base_uom: "EA", total_base: n,
        confidence: "low",
        note: `case of ${n}; unit size not stated`,
      };
    }
  }

  // P1 §3.8: bare ratio with no unit - `6/4`, `12/2`, `8/3`, `2/2`.
  // "Six of what, by four of what?" Unknowable; the row must surface
  // for human verification. Captures qty + size so the shape is
  // preserved in pack_qty / pack_size on the row, but uom + base_uom
  // + total_base stay null so no confident per-unit flows through.
  // Low confidence so the backfill maps the row to pack_state='check'.
  const bareRatioM = s.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
  if (bareRatioM) {
    const qty = parseInt(bareRatioM[1], 10);
    const size = parseFloat(bareRatioM[2]);
    return {
      qty,
      size,
      uom: null,
      dim: null,
      base_uom: null,
      total_base: null,
      confidence: "low",
      note: `bare ratio "${raw}" with no unit; needs human`,
    };
  }

  // 8. Fallback: garbled input the parser can't reduce.
  return { ...EMPTY, confidence: "none", note: `could not parse: "${raw}"` };
}

// Pretty-print a parsed pack for row display. Null-safe.
export function formatParsedPack(p: ParsedPack): string | null {
  if (p.qty != null && p.size != null && p.uom) {
    const qtyStr = Number.isInteger(p.qty) ? String(p.qty) : String(p.qty);
    const sizeStr = Number.isInteger(p.size) ? String(p.size) : String(p.size);
    if (p.qty === 1) return `${sizeStr} ${p.uom}`;
    return `${qtyStr}/${sizeStr} ${p.uom}`;
  }
  return null;
}
