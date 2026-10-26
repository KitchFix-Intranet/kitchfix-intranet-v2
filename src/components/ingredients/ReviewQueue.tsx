// Review queue - the human side of step 5. Server component: loads every
// proposed-food item + its matcher reason + its ingredient target (or
// ai-new proposed name), groups by target, sorts groups by total 12m
// dollars descending, renders. The actions UI is a separate client island
// (ReviewActions).

import { serviceClient } from "@/lib/supabase/service";
import { fmtCount, fmtUsd, fmtUsdLong, fmtDate } from "@/lib/fmt";
import { Tabs } from "./Tabs";
import { ReviewCard, type ReviewCardGroup } from "./ReviewCard";
import "./ingredients.css";
import "./review.css";

type ProposedItem = {
  id: string;
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  name: string;
  description_key: string;
  pack_text: string | null;
  billed_unit: string | null;
  catch_weight: boolean;
  ingredient_id: string | null;
  link_confidence: string | null;
  link_reason: string | null;
  usd_12m: number | null;
  lines_12m: number | null;
  accounts: string[] | null;
  last_seen: string | null;
};

type Ingredient = { id: string; name: string; parent: string | null };
type Vendor = { id: string; name: string };

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
        "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,billed_unit,catch_weight,ingredient_id,link_confidence,link_reason,usd_12m,lines_12m,accounts,last_seen"
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

  // Vendors + ingredients (both small, read once).
  const [vendorsRes, ingredientsRes, notFoodCountRes] = await Promise.all([
    client.from("pr_vendors").select("id,name"),
    client.from("pr_ingredients").select("id,name,parent").eq("status", "active").order("name"),
    client
      .from("pr_vendor_items")
      .select("id", { count: "exact", head: true })
      .like("link_reason", "ai-notfood:%")
      .eq("link_status", "none"),
  ]);
  if (vendorsRes.error) throw vendorsRes.error;
  if (ingredientsRes.error) throw ingredientsRes.error;

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
      g.items.push({
        id: it.id,
        name: it.name,
        vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
        itemNumber: it.item_number,
        pack: it.pack_text,
        billedUnit: it.billed_unit,
        usd12m: u12,
        lines12m: Number(it.lines_12m ?? 0),
        accountsCount: (it.accounts ?? []).length,
        lastSeen: it.last_seen,
        confidence: it.link_confidence,
        reason: parsed.body,
        catchWeight: it.catch_weight,
      });
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
      g.items.push({
        id: it.id,
        name: it.name,
        vendor: vendorNameById.get(it.vendor_id) ?? it.vendor_id,
        itemNumber: it.item_number,
        pack: it.pack_text,
        billedUnit: it.billed_unit,
        usd12m: u12,
        lines12m: Number(it.lines_12m ?? 0),
        accountsCount: (it.accounts ?? []).length,
        lastSeen: it.last_seen,
        confidence: it.link_confidence,
        reason: parsed.body,
        catchWeight: it.catch_weight,
      });
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
        <ul className="kf-review__groups" aria-label="Groups">
          {groups.map((g) => (
            <li key={g.key}>
              <ReviewCard group={g} ingredients={ingredients} />
            </li>
          ))}
        </ul>
      )}

      <p className="kf-review__hint">
        {fmtUsdLong(totals.groupedUsd)} across {fmtCount(groups.length)} groups.
        Confirmed last seen on each row {groups.length > 0 && groups[0].items.length > 0 && groups[0].items[0].lastSeen ? fmtDate(groups[0].items[0].lastSeen) : "-"}.
      </p>
    </div>
  );
}
