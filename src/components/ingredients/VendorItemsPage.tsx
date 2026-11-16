// N13: Server component for the Vendor items tab. Loads + shapes
// rows, then hands plain props to VendorItemsView (client). Chat-
// Claude can mount the view in isolation with sample rows without
// touching Next.
//
// What changed from the old render:
//   - adds `ingredient_id` + `price_estimate` to the page SELECT
//     (§3.1), + a batched name lookup on the page's ingredient ids
//     (§3.2), + a shared perBase helper (§3.3 - see
//     src/lib/ingredients/priceEstimate.ts) used by both this page
//     and /api/review/item.
//   - replaces the 7 chip segments with 10 (five Link, five Show
//     only) per §3.4. The URL enum keeps `status=unlinked`; the
//     chip label becomes "Not linked" and the filter narrows to
//     link_status='none' only (R7). New URL values: proposed,
//     linked, retail.
//   - deletes the VendorItemDrawer mount: a row opens ItemPanelById
//     instead. The ?drawer= URL param is unchanged in shape, but
//     it feeds a client fetch rather than a server-mounted drawer.

import { serviceClient } from "@/lib/supabase/service";
import { Tabs } from "./Tabs";
import { IdentBand } from "@/components/ui/IdentBand";
import { fmtCount } from "@/lib/fmt";
import { readPerBase, type PriceEstimate } from "@/lib/ingredients/priceEstimate";
import { startTimer, mark, endTimer } from "@/lib/timing";
import { VendorItemsView, type VendorSeg, type SortKey, type VendorSegCounts, type VendorItemViewRow, type LinkCell } from "./VendorItemsView";
import "./ingredients.css";
import "./table.css";
import "./chips.css";
import "./vendor-items-tab.css";

const DEFAULT_PAGE_SIZE = 80;

type Row = {
  id: string;
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  name: string;
  description_key: string;
  pack_text: string | null;
  billed_unit: string | null;
  catch_weight: boolean;
  is_food: boolean | null;
  status: string;
  link_status: string;
  duplicate_of_id: string | null;
  ingredient_id: string | null;
  price_estimate: PriceEstimate;
  usd_12m: number | null;
  lines_12m: number | null;
  accounts: string[] | null;
  last_seen: string | null;
};

type Vendor = { id: string; name: string };

type Params = {
  vendor?: string;
  status?: string;
  q?: string;
  page?: string;
  per?: string;
  sort?: string;
  drawer?: string;
};

function toParam(x: string | string[] | undefined): string | undefined {
  return Array.isArray(x) ? x[0] : x;
}

function parseSeg(v: string | undefined): VendorSeg {
  const s = (v ?? "all").toLowerCase();
  const allowed: ReadonlyArray<VendorSeg> = [
    "all", "unlinked", "proposed", "linked", "retail",
    "catch_weight", "no_number", "duplicates", "not_food", "archived",
  ];
  return (allowed as readonly string[]).includes(s) ? (s as VendorSeg) : "all";
}

function parseSort(v: string | undefined): SortKey {
  if (v === "lines" || v === "last_seen") return v;
  return "spend";
}

function parsePer(v: string | undefined): number {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.max(20, Math.min(100, n));
}

// Compose vendor + segment filters per §3.4.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(q: any, vendor: string | undefined, seg: VendorSeg): any {
  if (vendor && vendor !== "all") q = q.eq("vendor_id", vendor);
  if (seg === "unlinked") {
    // R7: narrowed to link_status='none' (today's unlinked also
    // counted 'proposed'). The URL value stays `unlinked`.
    q = q.eq("is_food", true).eq("link_status", "none").in("status", ["active", "resale"]);
  } else if (seg === "proposed") {
    q = q.eq("is_food", true).eq("link_status", "proposed").in("status", ["active", "resale"]);
  } else if (seg === "linked") {
    q = q.eq("link_status", "confirmed").eq("status", "active");
  } else if (seg === "retail") {
    q = q.eq("status", "resale");
  } else if (seg === "catch_weight") {
    q = q.eq("catch_weight", true).eq("is_food", true).in("status", ["active", "resale"]);
  } else if (seg === "no_number") {
    q = q.is("item_number_norm", null).eq("is_food", true).in("status", ["active", "resale"]);
  } else if (seg === "not_food") {
    q = q.eq("is_food", false);
  } else if (seg === "duplicates") {
    q = q.eq("status", "duplicate");
  } else if (seg === "archived") {
    q = q.eq("status", "archived");
  } else {
    q = q.in("status", ["active", "resale", "duplicate", "one_off", "not_food", "archived"]);
  }
  return q;
}

async function readSegCounts(
  client: ReturnType<typeof serviceClient>,
  vendor: string | undefined,
): Promise<VendorSegCounts> {
  const build = (seg: VendorSeg) =>
    applyFilters(
      client.from("pr_vendor_items").select("id", { count: "exact", head: true }),
      vendor,
      seg,
    );
  const [a, u, p, l, r, cw, nn, d, nf, ar] = await Promise.all([
    build("all"),
    build("unlinked"),
    build("proposed"),
    build("linked"),
    build("retail"),
    build("catch_weight"),
    build("no_number"),
    build("duplicates"),
    build("not_food"),
    build("archived"),
  ]);
  return {
    all: a.count ?? 0,
    unlinked: u.count ?? 0,
    proposed: p.count ?? 0,
    linked: l.count ?? 0,
    retail: r.count ?? 0,
    catch_weight: cw.count ?? 0,
    no_number: nn.count ?? 0,
    duplicates: d.count ?? 0,
    not_food: nf.count ?? 0,
    archived: ar.count ?? 0,
  };
}

function linkCell(
  r: Row,
  ingredientName: string | null,
  twinNumber: string | null,
): LinkCell {
  if (r.status === "duplicate") {
    return { kind: "duplicate", main: "Duplicate", sub: twinNumber ? `counted on #${twinNumber}` : "counted on the twin" };
  }
  if (r.status === "archived") {
    return { kind: "archived", main: "Archived", sub: "out of the catalog" };
  }
  if (r.status === "one_off") {
    return { kind: "one_off", main: "One-off", sub: "bought once" };
  }
  if (r.is_food === false) {
    return { kind: "not_food", main: "Not food", sub: "fees and supplies" };
  }
  if (r.status === "resale") {
    // Round 2 fix 10: retail-with-ingredient reads as the ingredient's
    // name over "retail"; retail-with-no-ingredient reads "Retail" over
    // "sold as-is" so the sub never repeats the main.
    return ingredientName
      ? { kind: "retail", main: ingredientName, sub: "retail" }
      : { kind: "retail", main: "Retail", sub: "sold as-is" };
  }
  if (r.link_status === "proposed") {
    return { kind: "proposed", main: ingredientName ?? "Proposed", sub: "proposed, needs review" };
  }
  if (r.link_status === "confirmed") {
    return { kind: "linked", main: ingredientName ?? "Linked", sub: "linked" };
  }
  if (r.link_status === "rejected") {
    return { kind: "rejected", main: "Rejected", sub: "link was turned down" };
  }
  return { kind: "not_linked", main: "Not linked", sub: "in the review queue" };
}

function shapeRow(
  r: Row,
  vendorName: string,
  ingredientName: string | null,
  twinNumber: string | null,
): VendorItemViewRow {
  const { perBase, perBaseUom } = readPerBase(r.price_estimate);
  const link = linkCell(r, ingredientName, twinNumber);
  // Attention bar: unlinked / proposed / food in active with no pack.
  const packMissing = !r.pack_text || r.pack_text.trim().length === 0;
  const activeOrResale = r.status === "active" || r.status === "resale";
  const attention =
    link.kind === "not_linked" ||
    link.kind === "proposed" ||
    (r.is_food === true && activeOrResale && packMissing);
  return {
    id: r.id,
    vendorName,
    itemNumber: r.item_number,
    name: r.name,
    catchWeight: r.catch_weight === true,
    twinOfNumber: twinNumber,
    link,
    packText: r.pack_text,
    billedUnit: r.billed_unit,
    packMissing,
    perBase,
    perBaseUom,
    usd12m: Number(r.usd_12m ?? 0),
    lines12m: Number(r.lines_12m ?? 0),
    lastSeenISO: r.last_seen,
    attention,
    isFood: r.is_food === true,
    status: r.status,
  };
}

export async function VendorItemsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const timer = startTimer("page:vendor-items");
  const p: Params = {
    vendor: toParam(searchParams.vendor),
    status: toParam(searchParams.status),
    q: toParam(searchParams.q),
    page: toParam(searchParams.page),
    per: toParam(searchParams.per),
    sort: toParam(searchParams.sort),
    drawer: toParam(searchParams.drawer),
  };
  const seg = parseSeg(p.status);
  const sort = parseSort(p.sort);
  const pageSize = parsePer(p.per);
  const page = Math.max(0, parseInt(p.page ?? "0", 10) || 0);
  const q = (p.q ?? "").trim();

  const client = serviceClient();

  const [vendorsRes, segCounts] = await Promise.all([
    client.from("pr_vendors").select("id,name").order("name", { ascending: true }),
    readSegCounts(client, p.vendor),
  ]);
  mark(timer, "batch1");
  const vendors = (vendorsRes.data ?? []) as Vendor[];

  let pageQuery = client
    .from("pr_vendor_items")
    .select(
      // §3.1: ingredient_id + price_estimate added. Nothing else.
      "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,billed_unit,catch_weight,is_food,status,link_status,duplicate_of_id,ingredient_id,price_estimate,usd_12m,lines_12m,accounts,last_seen",
      { count: "exact" },
    );
  pageQuery = applyFilters(pageQuery, p.vendor, seg);
  if (q.length > 0) {
    const safe = q.replace(/[,]/g, " ").replace(/\s+/g, " ");
    pageQuery = pageQuery.or(
      `name.ilike.%${safe}%,item_number.ilike.%${safe}%,description_key.ilike.%${safe}%`,
    );
  }
  if (sort === "lines") {
    pageQuery = pageQuery.order("lines_12m", { ascending: false, nullsFirst: false });
  } else if (sort === "last_seen") {
    pageQuery = pageQuery.order("last_seen", { ascending: false, nullsFirst: false });
  } else {
    pageQuery = pageQuery.order("usd_12m", { ascending: false, nullsFirst: false });
  }
  pageQuery = pageQuery.range(page * pageSize, page * pageSize + pageSize - 1);

  const { data: rows, error, count } = await pageQuery;
  if (error) {
    endTimer(timer, { ok: false, stage: "items" });
    return (
      <div className="kf-ing">
        <Tabs active="vendor-items" />
        <div className="kf-error" role="alert">
          <h3 className="kf-error__title">Couldn&rsquo;t load vendor items</h3>
          <p className="kf-error__body">{error.message}</p>
        </div>
      </div>
    );
  }
  mark(timer, "items");

  const items = (rows ?? []) as Row[];
  const total = count ?? 0;
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));

  // §3.2: batched ingredient-name lookup for the ingredient ids on
  // this page. Same shape as the twin-parent lookup below; one call
  // regardless of row count.
  const ingredientIds = Array.from(
    new Set(items.filter((r) => r.ingredient_id).map((r) => r.ingredient_id as string)),
  );
  const ingredientNameById = new Map<string, string>();
  if (ingredientIds.length > 0) {
    const { data: ings } = await client
      .from("pr_ingredients")
      .select("id,name")
      .in("id", ingredientIds);
    for (const row of (ings ?? []) as { id: string; name: string }[]) {
      ingredientNameById.set(row.id, row.name);
    }
  }

  // Twin-parent lookup (unchanged): the number is what the row's
  // "counted on #X" sub-line names.
  const twinParentIds = Array.from(
    new Set(items.filter((r) => r.duplicate_of_id).map((r) => r.duplicate_of_id as string)),
  );
  const twinNumberById = new Map<string, string | null>();
  if (twinParentIds.length > 0) {
    const { data: parents } = await client
      .from("pr_vendor_items")
      .select("id,item_number")
      .in("id", twinParentIds);
    for (const row of (parents ?? []) as { id: string; item_number: string | null }[]) {
      twinNumberById.set(row.id, row.item_number);
    }
  }

  const shaped: VendorItemViewRow[] = items.map((r) =>
    shapeRow(
      r,
      vendorNameById.get(r.vendor_id) ?? r.vendor_id,
      r.ingredient_id ? ingredientNameById.get(r.ingredient_id) ?? null : null,
      r.duplicate_of_id ? twinNumberById.get(r.duplicate_of_id) ?? null : null,
    ),
  );

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  mark(timer, "shape");
  endTimer(timer, { seg });

  return (
    <div className="kf-ing">
      <IdentBand
        eyebrow="Culinary office"
        title="Vendor items"
        facts={[
          { label: "Items", value: fmtCount(segCounts.all), note: "every line we've read" },
          { label: "Unlinked", value: fmtCount(segCounts.unlinked + segCounts.proposed), note: "waiting to be named" },
        ]}
      />

      <Tabs active="vendor-items" />

      <VendorItemsView
        rows={shaped}
        vendors={vendors}
        seg={seg}
        segCounts={segCounts}
        q={q}
        sort={sort}
        page={page}
        pageSize={pageSize}
        total={total}
        from={from}
        to={to}
        openId={p.drawer ?? null}
        vendorFilterId={p.vendor ?? "all"}
      />
    </div>
  );
}
