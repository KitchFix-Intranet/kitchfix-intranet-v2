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

// Dimension and base-unit lookup for every canonical uom this parser
// may emit. "CT" and "PC" fall through to count/EA (treated as units).
const DIM_BY_UOM: Record<string, Dim> = {
  LB: "weight", OZ: "weight", G: "weight", KG: "weight",
  FLOZ: "volume", L: "volume", ML: "volume", GAL: "volume", QT: "volume",
  CT: "count", DZ: "count", PC: "count", EA: "count",
};
const BASE_BY_DIM: Record<Dim, BaseUom> = {
  weight: "LB",
  volume: "FLOZ",
  count: "EA",
};
// Multiply source-unit value by this to get the base unit.
const TO_BASE: Record<string, number> = {
  // weight -> LB
  LB: 1,
  OZ: 1 / 16,
  G: 1 / 453.592,
  KG: 2.20462,
  // volume -> FLOZ
  FLOZ: 1,
  L: 33.814,
  ML: 0.033814,
  GAL: 128,
  QT: 32,
  // count -> EA
  EA: 1,
  DZ: 12,
  CT: 1,
  PC: 1,
};

// Normalize a raw uom token into one of the canonical uoms above, or
// null if we don't recognize it. Case-insensitive; strips periods.
function normUom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.toUpperCase().replace(/\./g, "").trim();
  if (!u) return null;
  if (/^LBS?$/.test(u)) return "LB";
  if (u === "#") return "LB";
  if (u === "OZ" || u === "OUNCE" || u === "OUNCES") return "OZ";
  if (u === "G" || u === "GR" || u === "GRAM" || u === "GRAMS") return "G";
  if (u === "KG") return "KG";
  if (u === "L" || u === "LTR" || u === "LT" || u === "LITER" || u === "LITRE") return "L";
  if (u === "ML") return "ML";
  if (u === "FLOZ" || u === "FO" || u === "FL OZ" || u === "FLUID OZ") return "FLOZ";
  if (u === "GAL" || u === "GALLON" || u === "GALLONS") return "GAL";
  if (u === "QT" || u === "QUART" || u === "QUARTS") return "QT";
  if (u === "DZ" || u === "DOZ" || u === "DZN" || u === "DOZEN") return "DZ";
  if (u === "CT" || u === "CNT" || u === "COUNT") return "CT";
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

// Trailing pack-container words we want to strip before parsing. Kept
// deliberately narrow so we don't eat a real unit; "PC" / "EA" are NOT
// in this list because they ARE units.
const TRAILING_CONTAINER = /\s+(CS|CASE|BX|BOX|BG|BAG|PK|PACK|COV|TUB|JAR|CTN|CARTON|CAN|CANS)\s*$/i;

export function parsePack(raw: string | null | undefined): ParsedPack {
  if (!raw || typeof raw !== "string") return { ...EMPTY, note: "empty" };
  let s = raw.trim();
  if (!s) return { ...EMPTY, note: "empty" };

  s = s.toUpperCase().replace(/\s+/g, " ");
  s = s.replace(TRAILING_CONTAINER, "").trim();

  const hasVaries = /\b(VARIES|AVERAGE|AVG)\b/.test(s);
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

  // 2. Range / average catch-weight: "41#-90# AVERAGE PC", "8-12#",
  // "2-3 LB". Midpoint used; confidence drops to low with a note.
  if (hasRange) {
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
    return {
      ...EMPTY,
      confidence: "low",
      note: `range detected but uom unclear: "${raw}"`,
    };
  }

  // 3. Standard qty/size UNIT pattern: "6/1 LB", "024/12OZ",
  // "48/2.60 OZ", "4/3 L", "12/5.3 OZ".
  const slashM = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*([A-Z#]+)/);
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

  // 4. Count-only pattern: "200 CT", "15 DZN", "2 PC", "30 COUNT".
  const countM = s.match(/^(\d+(?:\.\d+)?)\s*(DZ|DZN|DOZ|DOZEN|CT|CNT|COUNT|PC|PCS|PIECE|PIECES|EA|EACH)\b/);
  if (countM) {
    const n = parseFloat(countM[1]);
    const uom = normUom(countM[2])!;
    const conv = toBase(n, uom)!;
    return {
      qty: 1,
      size: n,
      uom,
      dim: "count",
      base_uom: "EA",
      total_base: conv.total,
      confidence: "high",
      note: null,
    };
  }

  // 5. Bare "N UNIT": "66 LB", "10 LB", "110#", "25 LBS".
  const bareM = s.match(/^(\d+(?:\.\d+)?)\s*(#|[A-Z]+)/);
  if (bareM) {
    const n = parseFloat(bareM[1]);
    const uom = normUom(bareM[2]);
    if (uom != null) {
      const conv = toBase(n, uom);
      if (conv) {
        return {
          qty: 1,
          size: n,
          uom,
          dim: conv.dim,
          base_uom: conv.base_uom,
          total_base: conv.total,
          confidence: hasVaries ? "low" : "high",
          note: hasVaries ? "contains VARIES/AVERAGE wording" : null,
        };
      }
    }
  }

  // 6. Fallback: garbled input the parser can't reduce.
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
