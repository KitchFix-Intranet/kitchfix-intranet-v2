#!/usr/bin/env node
// M2 §4A acceptance 6: a script Chat-Claude can run against production
// JSON exports. Per ingredient, prints OLD blended price (d45d8db
// logic frozen inline below) and NEW blended price (M2 logic, also
// inlined below so the script has no repo imports).
//
// Usage:
//   node scripts/m2_blend_diff.mjs ingredients.json items.json measures.json [--only=<ingredient_id>]
//
// JSON shapes (exact, flat arrays - no envelopes):
//
//   ingredients.json: [
//     {
//       "id": "<uuid>",
//       "name": "<string>",
//       "base_unit": "each" | "lb" | "oz" | "floz" | "gal" | "dozen" | ...
//     },
//     ...
//   ]
//
//   items.json: [
//     {
//       "id": "<uuid>",
//       "ingredient_id": "<uuid>" | null,
//       "grade": "premium" | null,
//       "usd_12m": number | null,
//       "pack_qty": number | null,
//       "pack_size": number | null,
//       "pack_uom": "EA" | "LB" | "FLOZ" | "GAL" | ... | null,
//       "case_weight_lb": number | null,
//       "price_estimate": { "per_base": number | null, "base_uom": string | null } | null,
//       "link_status": "confirmed" | "proposed" | ...,
//       "status": "active" | "resale" | "archived" | ...
//     },
//     ...
//   ]
//   (Only confirmed + live-status + ingredient_id-present rows are included.)
//
//   measures.json: [
//     { "ingredient_id": "<uuid>", "from_unit": "EA" | "LB" | ..., "qty": number,
//       "to_unit": "LB" | "OZ" | "FLOZ" | ..., "source": "book" | "house_test" | ... },
//     ...
//   ]
//
// Output: one line per ingredient whose blended price moves:
//   <ingredient_id>  <name>  old=<usd>/<unit>  new=<usd>/<unit>  moved=<pct>

import { readFileSync } from "node:fs";
import process from "node:process";

// --- Unit vocabulary (mirror of pack.ts) ---------------------------------
const DIM_BY_UOM = {
  LB: "weight", OZ: "weight", G: "weight", KG: "weight", CAN10: "weight",
  FLOZ: "volume", L: "volume", ML: "volume", GAL: "volume", QT: "volume", PT: "volume",
  CT: "count", DZ: "count", PC: "count", EA: "count",
};
const TO_BASE = {
  LB: 1, OZ: 1 / 16, G: 1 / 453.592, KG: 2.20462, CAN10: 6.6,
  FLOZ: 1, L: 33.814, ML: 0.033814, GAL: 128, QT: 32, PT: 16,
  EA: 1, DZ: 12, CT: 1, PC: 1,
};
const BASE_UNIT_MAP = {
  each: "EA", dozen: "DZ",
  lb: "LB", oz: "OZ", g: "G", kg: "KG",
  floz: "FLOZ", pt: "PT", qt: "QT", gal: "GAL", l: "L", ml: "ML",
};
function canonicalFromBaseUnit(bu) {
  if (!bu) return null;
  return BASE_UNIT_MAP[bu.toLowerCase()] ?? null;
}

// --- D45D8DB (OLD) blendStats + convertPer ---------------------------
// Verbatim from src/components/ingredients/IngredientMasters.tsx at
// d45d8db. Frozen here so the script has one old, one new, in one file.
const OLD_OUTLIER_RATIO = 3;
const OLD_OUTLIER_MIN = 3;
function oldMedianOf(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return s[Math.floor(n / 2)];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}
function oldWeighted(xs) {
  if (xs.length === 0) return null;
  let num = 0, den = 0;
  for (const x of xs) {
    const u = Number.isFinite(x.usd) && x.usd > 0 ? x.usd : 0;
    num += x.v * u; den += u;
  }
  if (den > 0) return num / den;
  const sum = xs.reduce((a, b) => a + b.v, 0);
  return sum / xs.length;
}
function oldBlendStats(priced) {
  if (priced.length === 0) return { survivorMean: null };
  const vals = priced.map((p) => p.v);
  const med = oldMedianOf(vals);
  if (priced.length < OLD_OUTLIER_MIN) return { survivorMean: oldWeighted(priced) };
  const low = med / OLD_OUTLIER_RATIO;
  const high = med * OLD_OUTLIER_RATIO;
  const survivors = priced.filter((p) => !(p.v > high || p.v < low));
  if (survivors.length === 0) return { survivorMean: null };
  return { survivorMean: oldWeighted(survivors) };
}
function oldConvertPer(value, from, to) {
  if (!from || !to) return null;
  const sf = TO_BASE[from.toUpperCase()];
  const tf = TO_BASE[to.toUpperCase()];
  if (sf == null || tf == null) return null;
  if (DIM_BY_UOM[from.toUpperCase()] !== DIM_BY_UOM[to.toUpperCase()]) return null;
  return value * (tf / sf);
}
function oldIngredientBlend(ingredient, itemsForIng) {
  const masterUom = canonicalFromBaseUnit(ingredient.base_unit);
  const priced = [];
  for (const it of itemsForIng) {
    const pe = it.price_estimate;
    const rawN = pe?.per_base != null ? Number(pe.per_base) : NaN;
    if (!Number.isFinite(rawN) || rawN <= 0) continue;
    const storedUom = pe?.base_uom ?? null;
    if (masterUom && storedUom) {
      const c = oldConvertPer(rawN, storedUom, masterUom);
      if (c == null) continue; // unit mismatch, excluded from blend
      priced.push({ id: it.id, v: c, usd: Number(it.usd_12m ?? 0) });
    } else {
      priced.push({ id: it.id, v: rawN, usd: Number(it.usd_12m ?? 0) });
    }
  }
  return oldBlendStats(priced).survivorMean;
}

// --- M2 (NEW) factor + priceInUnit + per-grade blended lens ------------
function factor(from, to, m) {
  const fu = String(from).toUpperCase(), tu = String(to).toUpperCase();
  const fd = DIM_BY_UOM[fu], td = DIM_BY_UOM[tu];
  const ft = TO_BASE[fu], tt = TO_BASE[tu];
  if (!fd || !td || ft == null || tt == null) return null;
  if (fd === td) return ft / tt;
  const edges = [];
  for (const row of (m.measures || [])) {
    const rfu = String(row.from_unit).toUpperCase(), rtu = String(row.to_unit).toUpperCase();
    const rf = DIM_BY_UOM[rfu], rt = DIM_BY_UOM[rtu];
    const q = Number(row.qty);
    const rft = TO_BASE[rfu], rtt = TO_BASE[rtu];
    if (!rf || !rt || !(q > 0) || rft == null || rtt == null) continue;
    const fwd = (q * rtt) / rft;
    edges.push([rf, rt, fwd], [rt, rf, 1 / fwd]);
  }
  const seen = { [fd]: 1 }, q = [fd];
  while (q.length) {
    const x = q.shift();
    if (x === td) return (ft * seen[td]) / tt;
    for (const [ef, et, k] of edges) {
      if (ef === x && !(et in seen)) { seen[et] = seen[x] * k; q.push(et); }
    }
  }
  return null;
}
function statedTotals(pq, ps, pu, cw) {
  const out = {};
  pu = (pu || "").toUpperCase();
  pq = Number(pq); ps = Number(ps);
  const have = pu && Number.isFinite(pq) && Number.isFinite(ps) && pq > 0 && ps > 0;
  if (have) {
    const d = DIM_BY_UOM[pu];
    if (d === "count") out.count = { qty: pq * ps * (pu === "DZ" ? 12 : 1), uom: "EA" };
    else if (d === "weight") { out.weight = { qty: pq * ps * TO_BASE[pu], uom: "LB" }; if (pq > 1) out.count = { qty: pq, uom: "EA" }; }
    else if (d === "volume") { out.volume = { qty: pq * ps * TO_BASE[pu], uom: "FLOZ" }; if (pq > 1) out.count = { qty: pq, uom: "EA" }; }
  }
  if (cw != null && cw > 0) out.weight = { qty: cw, uom: "LB" };
  return out;
}
function casePriceFrom(perBase, baseUom, pq, ps, pu) {
  pu = (pu || "").toUpperCase(); baseUom = (baseUom || "").toUpperCase();
  if (!pu || !baseUom || !(pq > 0) || !(ps > 0)) return null;
  if (DIM_BY_UOM[pu] !== DIM_BY_UOM[baseUom]) return null;
  const r = TO_BASE[pu] / TO_BASE[baseUom];
  if (!(r > 0)) return null;
  const mult = pu === "DZ" ? 12 : 1;
  return perBase * pq * ps * mult * r;
}
function priceInUnit(item, target, m) {
  if (!(item.perBase > 0)) return null;
  target = target.toUpperCase();
  const targetDim = DIM_BY_UOM[target];
  if (!targetDim) return null;
  const cp = casePriceFrom(item.perBase, item.baseUom, item.packQty, item.packSize, item.packUom);
  if (cp == null) {
    const k = factor(item.baseUom, target, m);
    if (k == null || !(k > 0)) return null;
    return { per: item.perBase / k };
  }
  const t = statedTotals(item.packQty, item.packSize, item.packUom, item.caseWeightLb);
  if (t[targetDim]) {
    const total = t[targetDim].qty / TO_BASE[target];
    if (!(total > 0)) return null;
    return { per: cp / total };
  }
  for (const kind of ["weight", "volume", "count"]) {
    const s = t[kind]; if (!s) continue;
    const k = factor(s.uom, target, m); if (k == null || !(k > 0)) continue;
    const total = s.qty * k;
    if (!(total > 0)) continue;
    return { per: cp / total };
  }
  return null;
}
function newMedianOf(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return s[Math.floor(n / 2)];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}
function newWeighted(xs) {
  if (xs.length === 0) return null;
  let num = 0, den = 0;
  for (const x of xs) {
    const u = Number.isFinite(x.usd) && x.usd > 0 ? x.usd : 0;
    num += x.v * u; den += u;
  }
  if (den > 0) return num / den;
  return xs.reduce((a, b) => a + b.v, 0) / xs.length;
}
function newBlendStats(priced) {
  if (priced.length === 0) return { excluded: new Set() };
  const vals = priced.map((p) => p.v);
  const med = newMedianOf(vals);
  if (priced.length < 3) return { excluded: new Set() };
  const low = med / 3, high = med * 3;
  const excluded = new Set();
  for (const p of priced) if (p.v > high || p.v < low) excluded.add(p.id);
  return { excluded };
}
// M2 §2.2: per-grade exclusion; blended survivor = union.
function newIngredientBlend(ingredient, itemsForIng, measures) {
  const target = canonicalFromBaseUnit(ingredient.base_unit);
  if (!target) return null;
  const priced = [];
  for (const it of itemsForIng) {
    const pe = it.price_estimate;
    const rawN = pe?.per_base != null ? Number(pe.per_base) : NaN;
    if (!Number.isFinite(rawN) || rawN <= 0) continue;
    const r = priceInUnit(
      {
        perBase: rawN,
        baseUom: pe.base_uom,
        packQty: it.pack_qty,
        packSize: it.pack_size,
        packUom: it.pack_uom,
        caseWeightLb: it.case_weight_lb,
      },
      target,
      { measures },
    );
    if (r == null) continue;
    priced.push({
      id: it.id, v: r.per, usd: Number(it.usd_12m ?? 0),
      grade: it.grade === "premium" ? "premium" : "standard",
    });
  }
  const buckets = { premium: [], standard: [] };
  for (const p of priced) buckets[p.grade].push(p);
  const excluded = new Set();
  const survivors = [];
  for (const g of ["premium", "standard"]) {
    const s = newBlendStats(buckets[g]);
    for (const id of s.excluded) excluded.add(id);
    for (const p of buckets[g]) if (!s.excluded.has(p.id)) survivors.push(p);
  }
  return newWeighted(survivors);
}

// --- Entry -----------------------------------------------------------
// Pure function (ingredients, items, measures) -> rows.
export function diffBlends(ingredients, items, measures) {
  const confirmed = items.filter(
    (it) =>
      it.ingredient_id &&
      it.link_status === "confirmed" &&
      ["active", "resale"].includes(it.status),
  );
  const byIng = new Map();
  for (const it of confirmed) {
    const list = byIng.get(it.ingredient_id) ?? [];
    list.push(it);
    byIng.set(it.ingredient_id, list);
  }
  const measuresByIng = new Map();
  for (const m of measures) {
    const list = measuresByIng.get(m.ingredient_id) ?? [];
    list.push(m);
    measuresByIng.set(m.ingredient_id, list);
  }
  const rows = [];
  for (const ing of ingredients) {
    const its = byIng.get(ing.id) ?? [];
    if (its.length === 0) continue;
    const oldP = oldIngredientBlend(ing, its);
    const newP = newIngredientBlend(ing, its, measuresByIng.get(ing.id) ?? []);
    const moved = oldP !== newP;
    rows.push({ id: ing.id, name: ing.name, base_unit: ing.base_unit, old: oldP, new: newP, moved });
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error("usage: node scripts/m2_blend_diff.mjs ingredients.json items.json measures.json [--only=<id>]");
    process.exit(2);
  }
  const ings = JSON.parse(readFileSync(args[0], "utf8"));
  const its = JSON.parse(readFileSync(args[1], "utf8"));
  const mes = JSON.parse(readFileSync(args[2], "utf8"));
  const onlyFlag = args.find((a) => a.startsWith("--only="));
  const onlyId = onlyFlag ? onlyFlag.slice("--only=".length) : null;
  const rows = diffBlends(ings, its, mes);
  const filtered = onlyId ? rows.filter((r) => r.id === onlyId) : rows.filter((r) => r.moved);
  console.log(`# ingredients compared: ${rows.length}`);
  console.log(`# moved: ${rows.filter((r) => r.moved).length}`);
  for (const r of filtered) {
    const o = r.old != null ? r.old.toFixed(4) : "null";
    const n = r.new != null ? r.new.toFixed(4) : "null";
    const pct = r.old && r.new ? ((r.new - r.old) / r.old * 100).toFixed(1) + "%" : "n/a";
    console.log(`${r.id}\t${r.name}\told=${o}/${r.base_unit}\tnew=${n}/${r.base_unit}\tmoved=${pct}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
