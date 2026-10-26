import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { Tabs } from "./Tabs";
import { Filters, StatusSeg } from "./Filters";
import { VendorItemDrawer } from "./VendorItemDrawer";
import "./ingredients.css";
import "./table.css";

const PAGE_SIZE = 80;

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
  drawer?: string;
};

function toParam(x: string | string[] | undefined): string | undefined {
  if (Array.isArray(x)) return x[0];
  return x;
}

function usdLong(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

export async function VendorItemsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const p: Params = {
    vendor: toParam(searchParams.vendor),
    status: toParam(searchParams.status),
    q: toParam(searchParams.q),
    page: toParam(searchParams.page),
    drawer: toParam(searchParams.drawer),
  };
  const seg: StatusSeg = ((): StatusSeg => {
    const s = (p.status ?? "all").toLowerCase();
    if (s === "unlinked" || s === "catch_weight" || s === "no_number" || s === "not_food" || s === "duplicates") return s;
    return "all";
  })();
  const page = Math.max(0, parseInt(p.page ?? "0", 10) || 0);
  const q = (p.q ?? "").trim();

  const client = serviceClient();

  // Vendors for the dropdown.
  const { data: vRows } = await client.from("pr_vendors").select("id,name").order("name", { ascending: true });
  const vendors = (vRows ?? []) as Vendor[];

  // Query.
  let query = client
    .from("pr_vendor_items")
    .select(
      "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,billed_unit,catch_weight,is_food,status,link_status,duplicate_of_id,usd_12m,lines_12m,accounts,last_seen",
      { count: "exact" }
    );

  if (p.vendor && p.vendor !== "all") query = query.eq("vendor_id", p.vendor);

  if (seg === "unlinked") {
    query = query.eq("is_food", true).in("link_status", ["none", "proposed"]).in("status", ["active", "resale"]);
  } else if (seg === "catch_weight") {
    query = query.eq("catch_weight", true).eq("is_food", true).in("status", ["active", "resale"]);
  } else if (seg === "no_number") {
    query = query.is("item_number_norm", null).eq("is_food", true).in("status", ["active", "resale"]);
  } else if (seg === "not_food") {
    query = query.eq("is_food", false);
  } else if (seg === "duplicates") {
    query = query.eq("status", "duplicate");
  } else {
    query = query.in("status", ["active", "resale", "duplicate", "one_off", "not_food", "archived"]);
  }

  if (q.length > 0) {
    const safe = q.replace(/[,]/g, " ").replace(/\s+/g, " ");
    query = query.or(`name.ilike.%${safe}%,item_number.ilike.%${safe}%,description_key.ilike.%${safe}%`);
  }

  query = query
    .order("usd_12m", { ascending: false, nullsFirst: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  const { data: rows, error, count } = await query;
  if (error) {
    return (
      <div className="kf-ing">
        <Tabs active="vendor-items" />
        <div className="kf-state"><div className="kf-state__title">Could not load vendor items</div><div className="kf-state__body">{error.message}</div></div>
      </div>
    );
  }

  const items = (rows ?? []) as Row[];
  const total = count ?? 0;
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));

  // Twin descriptions (for the "same as #..." badge).
  const twinParentIds = Array.from(new Set(items.filter((r) => r.duplicate_of_id).map((r) => r.duplicate_of_id!)));
  const twinParentById = new Map<string, { item_number: string | null; name: string }>();
  if (twinParentIds.length > 0) {
    const { data: parents } = await client.from("pr_vendor_items").select("id,item_number,name").in("id", twinParentIds);
    for (const row of (parents ?? []) as { id: string; item_number: string | null; name: string }[]) {
      twinParentById.set(row.id, { item_number: row.item_number, name: row.name });
    }
  }

  return (
    <div className="kf-ing">
      <header className="kf-ing__header">
        <span className="kf-eyebrow">Culinary office</span>
        <h2>Vendor items</h2>
        <p className="kf-ing__kicker">
          Every distinct item the invoice feed has seen, grouped by vendor and item number - or by description when a vendor sends no number. Click a row for details.
        </p>
      </header>

      <Tabs active="vendor-items" />

      <Filters
        vendors={vendors}
        selectedVendor={p.vendor ?? "all"}
        activeSeg={seg}
        q={q}
      />

      <section aria-label="Vendor items" className="kf-table-wrap">
        <div className="kf-table-meta">
          Showing {items.length} of {total.toLocaleString()}
          <span className="kf-table-meta__dot" />
          Sort: 12-month $ desc
        </div>
        <StatusLegend />
        {items.length === 0 ? (
          <div className="kf-state">
            <div className="kf-state__title">No vendor items match your filters</div>
            <div className="kf-state__body">Try clearing the search or widening the status segment.</div>
          </div>
        ) : (
          <>
            <table className="kf-table kf-only-desktop">
              <thead>
                <tr>
                  <th>Vendor / #</th>
                  <th>Description</th>
                  <th>Pack</th>
                  <th>Unit</th>
                  <th className="kf-table__num">12m $</th>
                  <th className="kf-table__num">12m lines</th>
                  <th>Sites</th>
                  <th>Last seen</th>
                  <th>Status</th>
                  <th>Ingredient</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => <TableRow key={r.id} r={r} vendorName={vendorNameById.get(r.vendor_id) ?? r.vendor_id} twinParent={r.duplicate_of_id ? twinParentById.get(r.duplicate_of_id) : undefined} />)}
              </tbody>
            </table>

            <ul className="kf-cards kf-only-phone">
              {items.map((r) => <PhoneCard key={r.id} r={r} vendorName={vendorNameById.get(r.vendor_id) ?? r.vendor_id} twinParent={r.duplicate_of_id ? twinParentById.get(r.duplicate_of_id) : undefined} />)}
            </ul>
          </>
        )}

        <Pagination page={page} total={total} params={p} seg={seg} q={q} />
      </section>

      {p.drawer ? <VendorItemDrawer id={p.drawer} params={p} seg={seg} q={q} vendorNameById={Object.fromEntries(vendorNameById)} /> : null}
    </div>
  );
}

function TableRow({
  r,
  vendorName,
  twinParent,
}: {
  r: Row;
  vendorName: string;
  twinParent?: { item_number: string | null; name: string };
}) {
  const href = buildHref(r.id);
  return (
    <tr>
      <td>
        <div className="kf-cell-strong">{vendorName}</div>
        <div className="kf-cell-sub">{r.item_number ?? "no number"}</div>
      </td>
      <td>
        <Link href={href} className="kf-cell-link">
          {r.name}
        </Link>
        {r.item_number_norm == null ? <span className="kf-pill kf-pill--warn">no item number</span> : null}
        {twinParent ? <span className="kf-pill kf-pill--twin">same as #{twinParent.item_number ?? "?"}</span> : null}
        <CatchWeightFlag row={r} />
      </td>
      <td>{r.pack_text ?? "-"}</td>
      <td>{r.billed_unit ?? "-"}</td>
      <td className="kf-table__num">${usdLong(Number(r.usd_12m ?? 0))}</td>
      <td className="kf-table__num">{Number(r.lines_12m ?? 0).toLocaleString()}</td>
      <td>{(r.accounts ?? []).length}</td>
      <td>{r.last_seen ?? "-"}</td>
      <td><StatusChip row={r} /></td>
      <td className="kf-muted">-</td>
    </tr>
  );
}

function PhoneCard({
  r,
  vendorName,
  twinParent,
}: {
  r: Row;
  vendorName: string;
  twinParent?: { item_number: string | null; name: string };
}) {
  const href = buildHref(r.id);
  return (
    <li>
      <Link href={href} className="kf-cards__item">
        <div className="kf-cards__head">
          <span className="kf-cards__vendor">{vendorName}</span>
          <span className="kf-cards__num">{r.item_number ?? "no number"}</span>
        </div>
        <div className="kf-cards__name">{r.name}</div>
        <div className="kf-cards__meta">
          <span>${usdLong(Number(r.usd_12m ?? 0))} / 12m</span>
          <span>{Number(r.lines_12m ?? 0).toLocaleString()} lines</span>
          <span>{(r.accounts ?? []).length} sites</span>
        </div>
        <div className="kf-cards__chips">
          <StatusChip row={r} />
          <CatchWeightFlag row={r} />
          {r.item_number_norm == null ? <span className="kf-pill kf-pill--warn">no item number</span> : null}
          {twinParent ? <span className="kf-pill kf-pill--twin">same as #{twinParent.item_number ?? "?"}</span> : null}
        </div>
      </Link>
    </li>
  );
}

// Status column shows the row's own status first (archived / one off / not food
// / duplicate / resale) and only falls through to link status for the default
// `active` case. Catch weight is a row attribute, not a status - it renders as
// a separate flag badge in the description cell.
function StatusChip({ row }: { row: Row }) {
  if (row.status === "duplicate") return <span className="kf-pill kf-pill--twin">Duplicate</span>;
  if (row.status === "archived") return <span className="kf-pill kf-pill--muted">Archived</span>;
  if (row.status === "one_off") return <span className="kf-pill kf-pill--muted">One off</span>;
  if (row.status === "not_food" || row.is_food === false) return <span className="kf-pill kf-pill--muted">Not food</span>;
  if (row.status === "resale") return <span className="kf-pill kf-pill--muted">Resale</span>;
  if (row.link_status === "proposed") return <span className="kf-pill kf-pill--info">Proposed</span>;
  if (row.link_status === "confirmed") return <span className="kf-pill kf-pill--good">Linked</span>;
  if (row.link_status === "rejected") return <span className="kf-pill kf-pill--muted">Rejected</span>;
  return <span className="kf-pill kf-pill--info">Unlinked</span>;
}

function CatchWeightFlag({ row }: { row: Row }) {
  if (!row.catch_weight) return null;
  return <span className="kf-pill kf-pill--warn" title="Catch weight">CW</span>;
}

function StatusLegend() {
  return (
    <div className="kf-table-legend" aria-label="Status legend">
      <span className="kf-table-legend__label">Link status:</span>
      <span className="kf-pill kf-pill--info">Unlinked</span>
      <span className="kf-pill kf-pill--info">Proposed</span>
      <span className="kf-pill kf-pill--good">Linked</span>
      <span className="kf-pill kf-pill--muted">Rejected</span>
      <span className="kf-table-legend__sep" />
      <span className="kf-pill kf-pill--warn" title="Catch weight">CW</span>
      <span className="kf-table-legend__hint">on rows priced by actual weight</span>
    </div>
  );
}

function buildHref(itemId: string): string {
  const url = new URL("/stockpot/ingredients/vendor-items", "http://x");
  url.searchParams.set("drawer", itemId);
  return url.pathname + "?" + url.searchParams.toString();
}

function Pagination({ page, total, params, seg, q }: { page: number; total: number; params: Params; seg: StatusSeg; q: string }) {
  const last = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const prevQS = toQS({ ...params, page: String(Math.max(0, page - 1)) }, seg, q);
  const nextQS = toQS({ ...params, page: String(Math.min(last, page + 1)) }, seg, q);
  return (
    <nav className="kf-pagination" aria-label="Pages">
      <Link href={`?${prevQS}`} className={`kf-btn kf-btn--line kf-btn--sm${page === 0 ? " is-disabled" : ""}`}>Prev</Link>
      <span className="kf-pagination__loc">Page {page + 1} of {Math.max(1, last + 1)}</span>
      <Link href={`?${nextQS}`} className={`kf-btn kf-btn--line kf-btn--sm${page >= last ? " is-disabled" : ""}`}>Next</Link>
    </nav>
  );
}

function toQS(p: Params, seg: StatusSeg, q: string): string {
  const u = new URLSearchParams();
  if (p.vendor && p.vendor !== "all") u.set("vendor", p.vendor);
  if (seg !== "all") u.set("status", seg);
  if (q.length > 0) u.set("q", q);
  if (p.page && p.page !== "0") u.set("page", p.page);
  if (p.drawer) u.set("drawer", p.drawer);
  return u.toString();
}
