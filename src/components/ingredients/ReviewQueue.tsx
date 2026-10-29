// Review queue - the human side of step 5. Server component: loads every
// proposed-food item + its matcher reason + its ingredient target (or
// ai-new proposed name), groups by target, sorts groups by total 12m
// dollars descending, renders. The actions UI is a separate client island
// (ReviewActions).

import { serviceClient } from "@/lib/supabase/service";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { Tabs } from "./Tabs";
import { ReviewCard, type ReviewCardGroup } from "./ReviewCard";
import { ReviewLedger } from "./ReviewLedger";
import { ReviewFilter, type ReviewFilterGroup } from "./ReviewFilter";
import "./ingredients.css";
import "./review.css";
// Pulled in so the search field inherits the shared .kf-field--search
// token set from Vendor-items / Ingredients (magnifier, Enter / clear
// pill). Keeps the input visually native across tabs.
import "./table.css";

type ProposedItem = {
  id: string;
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  name: string;
  description_key: string;
  pack_text: string | null;
  pack_qty: number | null;
  pack_size: number | null;
  pack_uom: string | null;
  pack_state: string;
  pack_override: unknown;
  billed_unit: string | null;
  catch_weight: boolean;
  ingredient_id: string | null;
  link_confidence: string | null;
  link_reason: string | null;
  usd_12m: number | null;
  lines_12m: number | null;
  accounts: string[] | null;
  last_seen: string | null;
  flagged: boolean | null;
  flag_note: string | null;
  flagged_by: string | null;
  flagged_at: string | null;
  price_estimate: {
    per_base?: number | null;
    base_uom?: string | null;
    case_price?: number | null;
    case_price_source?: string | null;
    pack_source?: string | null;
    confidence?: string | null;
    note?: string | null;
  } | null;
};

type Ingredient = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  resale: boolean;
};
type Vendor = { id: string; name: string };

// Catalog row from pr_vendor_catalog (8,867 rows, 8 vendors loaded as
// of this step). Keyed on (vendor_id, item_number_norm) to join to
// pr_vendor_items. When present the catalog wins for pack / price /
// clean name / gtin; the invoice OCR values stay as the fallback and
// render de-emphasized under the clean name.
type CatalogRow = {
  vendor_id: string;
  item_number_norm: string;
  clean_name: string | null;
  pack_text: string | null;
  catalog_price: number | null;
  gtin: string | null;
};

type AiNewPayload = { proposed_name?: string; proposed_parent?: string | null; reason?: string };

function parseReason(raw: string | null): { prefix: "ai" | "ai-new" | "ai-notfood" | "alias" | "other" | null; body: string; aiNew?: AiNewPayload } {
  if (!raw) return { prefix: null, body: "" };
  if (raw.startsWith("ai-new:")) {
    const body = raw.slice("ai-new:".length);
    let aiNew: AiNewPayload = {};
    try { aiNew = JSON.parse(body) as AiNewPayload; } catch { /* ignore - render body raw */ }
    return { prefix: "ai-new", body: aiNew.reason ?? body, aiNew };
  }
  if (raw.startsWith("ai-notfood:")) return { prefix: "ai-notfood", body: raw.slice("ai-notfood:".length) };
  if (raw.startsWith("ai:")) return { prefix: "ai", body: raw.slice("ai:".length) };
  if (raw.startsWith("alias:")) return { prefix: "alias", body: raw.slice("alias:".length) };
  return { prefix: "other", body: raw };
}

async function loadReview() {
  const client = serviceClient();

  // Paginated read of every proposed row (PostgREST cap 1000). dollar-ordered.
  const items: ProposedItem[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("pr_vendor_items")
      .select(
        "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,pack_qty,pack_size,pack_uom,pack_state,pack_override,billed_unit,catch_weight,ingredient_id,link_confidence,link_reason,usd_12m,lines_12m,accounts,last_seen,flagged,flag_note,flagged_by,flagged_at,price_estimate"
      )
      .eq("link_status", "proposed")
      .in("status", ["active", "resale"])
      .order("usd_12m", { ascending: false, nullsFirst: false })
      .range(from, from + page - 1);
    if (error) throw error;
    const chunk = (data ?? []) as ProposedItem[];
    items.push(...chunk);
    if (chunk.length < page) break;
    from += page;
  }

  // Vendors + ingredients (both small, read once). category + resale on
  // the ingredient feed the detail panel's category dropdown + resale
  // toggle.
  const [vendorsRes, ingredientsRes, notFoodCountRes] = await Promise.all([
    client.from("pr_vendors").select("id,name"),
    client
      .from("pr_ingredients")
      .select("id,name,parent,category,resale")
      .eq("status", "active")
      .order("name"),
    client
      .from("pr_vendor_items")
      .select("id", { count: "exact", head: true })
      .like("link_reason", "ai-notfood:%")
      .eq("link_status", "none"),
  ]);
  if (vendorsRes.error) throw vendorsRes.error;
  if (ingredientsRes.error) throw ingredientsRes.error;

  // Catalog enrichment: read pr_vendor_catalog in batches grouped by
  // vendor_id, keyed on item_number_norm. Only items with a non-null
  // item_number_norm can match; the rest fall through to invoice-only
  // values. Pattern mirrors the matcher's catalog read (one query per
  // vendor; .in() on the normalized numbers from the queue).
  const catalogByKey = new Map<string, CatalogRow>();
  {
    const byVendor = new Map<string, Set<string>>();
    for (const it of items) {
      if (!it.item_number_norm) continue;
      let set = byVendor.get(it.vendor_id);
      if (!set) {
        set = new Set();
        byVendor.set(it.vendor_id, set);
      }
      set.add(it.item_number_norm);
    }
    for (const [vendorId, nums] of byVendor) {
      const list = Array.from(nums);
      const page = 500;
      for (let i = 0; i < list.length; i += page) {
        const slice = list.slice(i, i + page);
        const { data, error } = await client
          .from("pr_vendor_catalog")
          .select("vendor_id,item_number_norm,clean_name,pack_text,catalog_price,gtin")
          .eq("vendor_id", vendorId)
          .in("item_number_norm", slice);
        if (error) throw error;
        for (const r of (data ?? []) as CatalogRow[]) {
          if (!r.item_number_norm) continue;
          catalogByKey.set(`${r.vendor_id}#${r.item_number_norm}`, r);
        }
      }
    }
  }

  // Latest unit_price per vendor_item for the "Unit price" column. We
  // narrow to the vendor_item_ids actually on the queue, then paginate
  // ordered by invoice_date desc and take the first observation per
  // item. Items with no valid observation show "-" in the UI (never a
  // fabricated number). The label makes clear this is the *billed* unit
  // price, not a normalized $/lb across pack sizes (true normalization
  // needs pack parsing, which is step 3).
  const itemIds = items.map((it) => it.id);
  const unitPriceByItem = new Map<string, { unitPrice: number; billedUnit: string | null }>();
  if (itemIds.length > 0) {
    const chunk = 400; // keep the .in list small; PostgREST limits URL length
    for (let i = 0; i < itemIds.length; i += chunk) {
      const slice = itemIds.slice(i, i + chunk);
      let obsFrom = 0;
      for (;;) {
        const { data: obsData, error: obsErr } = await client
          .from("pr_price_observations")
          .select("vendor_item_id,unit_price,billed_unit,invoice_date")
          .in("vendor_item_id", slice)
          .is("excluded_reason", null)
          .not("unit_price", "is", null)
          .order("invoice_date", { ascending: false, nullsFirst: false })
          .range(obsFrom, obsFrom + 999);
        if (obsErr) throw obsErr;
        const page = (obsData ?? []) as Array<{
          vendor_item_id: string;
          unit_price: number | null;
          billed_unit: string | null;
          invoice_date: string | null;
        }>;
        for (const o of page) {
          if (unitPriceByItem.has(o.vendor_item_id)) continue;
          if (o.unit_price == null) continue;
          unitPriceByItem.set(o.vendor_item_id, {
            unitPrice: Number(o.unit_price),
            billedUnit: o.billed_unit,
          });
        }
        if (page.length < 1000) break;
        obsFrom += 1000;
      }
    }
  }

  const vendors = (vendorsRes.data ?? []) as Vendor[];
  const ingredients = (ingredientsRes.data ?? []) as Ingredient[];
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

  // Group:
  //   key `ex:<ingredient_id>` for existing-ingredient groups
  //   key `new:<proposed_name_lower>` for ai-new groups
  //   notFood items are shown as a count only (filter view later)
  const groups = new Map<string, ReviewCardGroup>();
  for (const it of items) {
    const parsed = parseReason(it.link_reason);
    const u12 = Number(it.usd_12m ?? 0);
    if (it.ingredient_id) {
      const ing = ingredientById.get(it.ingredient_id);
      if (!ing) continue; // orphan - matcher wrote an id that got merged; skip silently
      const key = `ex:${it.ingredient_id}`;
      const g = groups.get(key) ?? {
        key,
        kind: "existing" as const,
        ingredient: ing,
        proposedName: null,
        proposedParent: null,
        totalUsd12m: 0,
        totalLines12m: 0,
        items: [],
      };
      g.totalUsd12m += u12;
      g.totalLines12m += Number(it.lines_12m ?? 0);
      {
        const up = unitPriceByItem.get(it.id) ?? null;
        const cat =
          it.item_number_norm ? catalogByKey.get(`${it.vendor_id}#${it.item_number_norm}`) ?? null : null;
        const catalogClean = cat?.clean_name?.trim() || null;
        const catalogPack = cat?.pack_text?.trim() || null;
        const catalogPrice = cat && cat.catalog_price != null ? Number(cat.catalog_price) : null;
        const gtin = cat?.gtin?.trim() || null;
        const hasManualOverride = it.pack_override !== null;
        // Pack precedence: user manual override > catalog > invoice
        // OCR. Each tier carries a source label so the row is clear
        // about which value Kevin's looking at.
        const packDisplay = hasManualOverride
          ? it.pack_text
          : (catalogPack ?? it.pack_text);
        const packSource: "override" | "catalog" | "invoice" | null = hasManualOverride
          ? "override"
          : catalogPack
            ? "catalog"
            : it.pack_text
              ? "invoice"
              : null;
        // Normalized pack display from the backfill: "6/1 LB" style.
        // Falls back to the raw pack text when the backfill hasn't
        // produced qty+size+uom yet.
        const normalizedPack =
          it.pack_qty != null && it.pack_size != null && it.pack_uom
            ? (Number(it.pack_qty) === 1
                ? `${it.pack_size} ${it.pack_uom}`
                : `${it.pack_qty}/${it.pack_size} ${it.pack_uom}`)
            : null;
        const pe = it.price_estimate ?? null;
        const perBase =
          pe && pe.per_base != null && Number.isFinite(Number(pe.per_base))
            ? Number(pe.per_base)
            : null;
        const perBaseConfidence =
          pe && (pe.confidence === "high" || pe.confidence === "low" || pe.confidence === "override" || pe.confidence === "derived")
            ? (pe.confidence as "high" | "low" | "override" | "derived")
            : null;
        g.items.push({
          id: it.id,
          name: it.name,
          vendorOcrName: it.name,
          displayName: catalogClean ?? it.name,
          displayNameSource: catalogClean ? "catalog" : "invoice",
          vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
          itemNumber: it.item_number,
          pack: packDisplay,
          packNormalized: normalizedPack,
          packState: it.pack_state,
          packSource,
          packManualOverride: hasManualOverride,
          billedUnit: it.billed_unit,
          usd12m: u12,
          lines12m: Number(it.lines_12m ?? 0),
          accounts: it.accounts ?? [],
          accountsCount: (it.accounts ?? []).length,
          lastSeen: it.last_seen,
          confidence: it.link_confidence,
          reason: parsed.body,
          catchWeight: it.catch_weight,
          unitPrice: up ? up.unitPrice : null,
          unitPriceUnit: up ? up.billedUnit ?? it.billed_unit : null,
          catalogPrice,
          gtin,
          perBase,
          perBaseUom: pe?.base_uom ?? null,
          perBaseConfidence,
          perBaseNote: pe?.note ?? null,
          caseSource: (pe?.case_price_source as "catalog" | "billed" | "catch_weight" | "catalog_lb" | "override" | "actuals_base_unit" | "actuals_weight" | "actuals_case" | null) ?? null,
          flagged: it.flagged === true,
          flagNote: it.flag_note ?? null,
          flaggedBy: it.flagged_by ?? null,
          flaggedAt: it.flagged_at ?? null,
        });
      }
      groups.set(key, g);
    } else if (parsed.prefix === "ai-new" && parsed.aiNew?.proposed_name) {
      const nameKey = parsed.aiNew.proposed_name.trim().toLowerCase();
      const key = `new:${nameKey}`;
      const g = groups.get(key) ?? {
        key,
        kind: "new" as const,
        ingredient: null,
        proposedName: parsed.aiNew.proposed_name.trim(),
        proposedParent: parsed.aiNew.proposed_parent ?? null,
        totalUsd12m: 0,
        totalLines12m: 0,
        items: [],
      };
      g.totalUsd12m += u12;
      g.totalLines12m += Number(it.lines_12m ?? 0);
      {
        const up = unitPriceByItem.get(it.id) ?? null;
        const cat =
          it.item_number_norm ? catalogByKey.get(`${it.vendor_id}#${it.item_number_norm}`) ?? null : null;
        const catalogClean = cat?.clean_name?.trim() || null;
        const catalogPack = cat?.pack_text?.trim() || null;
        const catalogPrice = cat && cat.catalog_price != null ? Number(cat.catalog_price) : null;
        const gtin = cat?.gtin?.trim() || null;
        const hasManualOverride = it.pack_override !== null;
        // Pack precedence: user manual override > catalog > invoice
        // OCR. Each tier carries a source label so the row is clear
        // about which value Kevin's looking at.
        const packDisplay = hasManualOverride
          ? it.pack_text
          : (catalogPack ?? it.pack_text);
        const packSource: "override" | "catalog" | "invoice" | null = hasManualOverride
          ? "override"
          : catalogPack
            ? "catalog"
            : it.pack_text
              ? "invoice"
              : null;
        // Normalized pack display from the backfill: "6/1 LB" style.
        // Falls back to the raw pack text when the backfill hasn't
        // produced qty+size+uom yet.
        const normalizedPack =
          it.pack_qty != null && it.pack_size != null && it.pack_uom
            ? (Number(it.pack_qty) === 1
                ? `${it.pack_size} ${it.pack_uom}`
                : `${it.pack_qty}/${it.pack_size} ${it.pack_uom}`)
            : null;
        const pe = it.price_estimate ?? null;
        const perBase =
          pe && pe.per_base != null && Number.isFinite(Number(pe.per_base))
            ? Number(pe.per_base)
            : null;
        const perBaseConfidence =
          pe && (pe.confidence === "high" || pe.confidence === "low" || pe.confidence === "override" || pe.confidence === "derived")
            ? (pe.confidence as "high" | "low" | "override" | "derived")
            : null;
        g.items.push({
          id: it.id,
          name: it.name,
          vendorOcrName: it.name,
          displayName: catalogClean ?? it.name,
          displayNameSource: catalogClean ? "catalog" : "invoice",
          vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
          itemNumber: it.item_number,
          pack: packDisplay,
          packNormalized: normalizedPack,
          packState: it.pack_state,
          packSource,
          packManualOverride: hasManualOverride,
          billedUnit: it.billed_unit,
          usd12m: u12,
          lines12m: Number(it.lines_12m ?? 0),
          accounts: it.accounts ?? [],
          accountsCount: (it.accounts ?? []).length,
          lastSeen: it.last_seen,
          confidence: it.link_confidence,
          reason: parsed.body,
          catchWeight: it.catch_weight,
          unitPrice: up ? up.unitPrice : null,
          unitPriceUnit: up ? up.billedUnit ?? it.billed_unit : null,
          catalogPrice,
          gtin,
          perBase,
          perBaseUom: pe?.base_uom ?? null,
          perBaseConfidence,
          perBaseNote: pe?.note ?? null,
          caseSource: (pe?.case_price_source as "catalog" | "billed" | "catch_weight" | "catalog_lb" | "override" | "actuals_base_unit" | "actuals_weight" | "actuals_case" | null) ?? null,
          flagged: it.flagged === true,
          flagNote: it.flag_note ?? null,
          flaggedBy: it.flagged_by ?? null,
          flaggedAt: it.flagged_at ?? null,
        });
      }
      groups.set(key, g);
    }
    // Items with link_status='proposed' but no ingredient_id and no ai-new
    // reason are malformed - skip silently; a future hotfix can surface them.
  }

  // Sort member items inside each group dollar-desc; sort groups dollar-desc.
  const groupList = Array.from(groups.values()).map((g) => ({
    ...g,
    items: g.items.sort((a, b) => b.usd12m - a.usd12m),
  }));
  groupList.sort((a, b) => b.totalUsd12m - a.totalUsd12m);

  // Overall totals.
  const totalItems = items.length;
  const totalUsd = items.reduce((s, it) => s + Number(it.usd_12m ?? 0), 0);
  const groupedUsd = groupList.reduce((s, g) => s + g.totalUsd12m, 0);
  const notFoodCount = notFoodCountRes.count ?? 0;

  return {
    groups: groupList,
    ingredients,
    totals: { items: totalItems, usd: totalUsd, groupedUsd, groups: groupList.length, notFood: notFoodCount },
  };
}

export async function ReviewQueue() {
  const { groups, ingredients, totals } = await loadReview();

  return (
    <div className="kf-ing">
      <header className="kf-ing__header">
        <span className="kf-eyebrow">Culinary office</span>
        <h2>Review queue</h2>
        <p className="kf-ing__kicker">
          Every proposal the matcher wrote. Grouped by proposed ingredient; dollar-ordered.
          Confirm a whole group in one click to turn its items into permanent links.
        </p>
      </header>

      <Tabs active="review" />

      <section className="kf-review__meta" aria-label="Queue totals">
        <div className="kf-review__meta-stat">
          <span className="kf-review__meta-label">Proposals</span>
          <strong>{fmtCount(totals.items)}</strong>
          <span className="kf-review__meta-sub">
            {fmtUsd(totals.usd)} across {fmtCount(totals.groups)} groups
          </span>
        </div>
        <div className="kf-review__meta-stat">
          <span className="kf-review__meta-label">Flagged not food</span>
          <strong>{fmtCount(totals.notFood)}</strong>
          <span className="kf-review__meta-sub">matcher called them not food</span>
        </div>
      </section>

      {groups.length === 0 ? (
        <div className="kf-empty">
          <div>
            <div className="kf-empty__title">No proposals waiting</div>
            <div className="kf-empty__body">
              Run the matcher (<code>POST /api/match</code>) to populate this queue; or confirm what&rsquo;s
              already linked on the vendor-items table.
            </div>
          </div>
        </div>
      ) : (
        <ReviewFilter
          groups={groups.map(toFilterGroup)}
          cards={groups.map((g) => ({
            key: g.key,
            node: <ReviewCard group={g} ingredients={ingredients} />,
          }))}
          totals={{
            items: totals.items,
            usd: totals.usd,
            groups: totals.groups,
            notFood: totals.notFood,
            groupedUsd: totals.groupedUsd,
          }}
        />
      )}

      <ReviewLedger ingredients={ingredients} />
    </div>
  );
}

// Project the richer server-side group into the narrow shape the client
// filter needs. Only serializable fields; no React elements or
// functions.
function toFilterGroup(g: ReviewCardGroup): ReviewFilterGroup {
  const latestLastSeen = g.items.reduce<string | null>((acc, it) => {
    if (!it.lastSeen) return acc;
    if (!acc) return it.lastSeen;
    return it.lastSeen > acc ? it.lastSeen : acc;
  }, null);
  return {
    key: g.key,
    kind: g.kind,
    ingredientName: g.ingredient?.name ?? null,
    ingredientParent: g.ingredient?.parent ?? null,
    // category + resale carry the ingredient's super-category and
    // resale flag to the client-side filters. ai-new groups have no
    // ingredient yet so both read null/false; those surface under
    // "Needs category" in the filter chips.
    category: g.ingredient?.category ?? null,
    resale: g.ingredient?.resale ?? false,
    proposedName: g.proposedName,
    proposedParent: g.proposedParent,
    totalUsd12m: g.totalUsd12m,
    totalLines12m: g.totalLines12m,
    memberCount: g.items.length,
    members: g.items.map((it) => ({ name: it.name, vendor: it.vendor })),
    lastSeen: latestLastSeen,
  };
}
