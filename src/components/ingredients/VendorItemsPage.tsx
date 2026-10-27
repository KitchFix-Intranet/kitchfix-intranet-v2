// Vendor items table. Render V4 shape: no page head, sticky thead inside a
// fixed-colgroup card, 48-px nowrap-ellipsis rows, whole-row clickable via
// <RowLink>, segment chips with live counts, server-side sort, compact
// pager, phone cards. Export CSV + Run intake sit in the @topbar slot.

import { ChevronLeft, ChevronRight, Scale, Copy, ArrowDown } from "lucide-react";
import { serviceClient } from "@/lib/supabase/service";
import { fmtCount, fmtDate, fmtUsdLong } from "@/lib/fmt";
import { Tabs } from "./Tabs";
import { Filters, type StatusSeg } from "./Filters";
import { RowLink } from "./RowLink";
import { SortSelect } from "./SortSelect";
import { type SortKey, parseSort } from "./sortKeys";
import { VendorItemDrawer } from "./VendorItemDrawer";
import "./ingredients.css";
import "./table.css";

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

function parseSeg(v: string | undefined): StatusSeg {
  const s = (v ?? "all").toLowerCase();
  if (s === "unlinked" || s === "catch_weight" || s === "no_number" || s === "not_food" || s === "duplicates") return s;
  return "all";
}

function parsePer(v: string | undefined): number {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.max(20, Math.min(100, n));
}

// Build the base vendor-items query with vendor + segment filters applied
// but no sort / range / search / count mode.
function baseQuery(
  client: ReturnType<typeof serviceClient>,
  vendor: string | undefined,
  seg: StatusSeg
) {
  let q = client.from("pr_vendor_items");
  // The .select below is replaced by the caller with its own options.
  // Here we only compose the filters.
  return applyFilters(q, vendor, seg);
}

// Supabase query builder is chainable; `any` kept narrow to the local scope.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(q: any, vendor: string | undefined, seg: StatusSeg): any {
  if (vendor && vendor !== "all") q = q.eq("vendor_id", vendor);
  if (seg === "unlinked") {
    q = q.eq("is_food", true).in("link_status", ["none", "proposed"]).in("status", ["active", "resale"]);
  } else if (seg === "catch_weight") {
    q = q.eq("catch_weight", true).eq("is_food", true).in("status", ["active", "resale"]);
  } else if (seg === "no_number") {
    q = q.is("item_number_norm", null).eq("is_food", true).in("status", ["active", "resale"]);
  } else if (seg === "not_food") {
    q = q.eq("is_food", false);
  } else if (seg === "duplicates") {
    q = q.eq("status", "duplicate");
  } else {
    q = q.in("status", ["active", "resale", "duplicate", "one_off", "not_food", "archived"]);
  }
  return q;
}

type SegCounts = { all: number; unlinked: number; catch_weight: number; no_number: number; not_food: number; duplicates: number };

async function readSegCounts(
  client: ReturnType<typeof serviceClient>,
  vendor: string | undefined
): Promise<SegCounts> {
  const build = (seg: StatusSeg) => {
    const q = applyFilters(
      client.from("pr_vendor_items").select("id", { count: "exact", head: true }),
      vendor,
      seg
    );
    return q;
  };
  const [a, u, c, n, nf, d] = await Promise.all([
    build("all"),
    build("unlinked"),
    build("catch_weight"),
    build("no_number"),
    build("not_food"),
    build("duplicates"),
  ]);
  return {
    all: a.count ?? 0,
    unlinked: u.count ?? 0,
    catch_weight: c.count ?? 0,
    no_number: n.count ?? 0,
    not_food: nf.count ?? 0,
    duplicates: d.count ?? 0,
  };
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
  const vendors = (vendorsRes.data ?? []) as Vendor[];

  // Page query.
  let pageQuery = client
    .from("pr_vendor_items")
    .select(
      "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,billed_unit,catch_weight,is_food,status,link_status,duplicate_of_id,usd_12m,lines_12m,accounts,last_seen",
      { count: "exact" }
    );
  pageQuery = applyFilters(pageQuery, p.vendor, seg);
  if (q.length > 0) {
    const safe = q.replace(/[,]/g, " ").replace(/\s+/g, " ");
    pageQuery = pageQuery.or(
      `name.ilike.%${safe}%,item_number.ilike.%${safe}%,description_key.ilike.%${safe}%`
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

  const items = (rows ?? []) as Row[];
  const total = count ?? 0;
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));

  // Twin parent lookups for "Twin of #X" title.
  const twinParentIds = Array.from(
    new Set(items.filter((r) => r.duplicate_of_id).map((r) => r.duplicate_of_id as string))
  );
  const twinParentById = new Map<string, { item_number: string | null; name: string }>();
  if (twinParentIds.length > 0) {
    const { data: parents } = await client
      .from("pr_vendor_items")
      .select("id,item_number,name")
      .in("id", twinParentIds);
    for (const row of (parents ?? []) as { id: string; item_number: string | null; name: string }[]) {
      twinParentById.set(row.id, { item_number: row.item_number, name: row.name });
    }
  }

  const last = Math.max(0, Math.ceil(total / pageSize) - 1);
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="kf-ing">
      <Tabs active="vendor-items" />

      <Filters
        vendors={vendors}
        selectedVendor={p.vendor ?? "all"}
        activeSeg={seg}
        q={q}
        segCounts={segCounts}
        pageSize={pageSize}
      />

      <section aria-label="Vendor items" className="kf-table-wrap">
        <div className="kf-table-meta">
          <div className="kf-table-meta__left">
            <strong>{fmtCount(total)}</strong>
            <span>items</span>
            <span className="kf-table-meta__dot" />
            <span>Showing {fmtCount(from)}-{fmtCount(to)}</span>
          </div>
          <div className="kf-table-meta__right">
            <SortSelect value={sort} />
            <Pager page={page} last={last} params={p} seg={seg} q={q} sort={sort} pageSize={pageSize} />
          </div>
        </div>
        <StatusLegend />

        {items.length === 0 ? (
          <EmptyRow />
        ) : (
          <>
            <div className="kf-table-scroll kf-only-desktop">
              <table className="kf-table">
                <colgroup>
                  <col style={{ width: 146 }} />
                  <col style={{ width: 100 }} />
                  <col />
                  <col style={{ width: 136 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 64 }} />
                  <col style={{ width: 92 }} />
                  <col style={{ width: 104 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th>Item #</th>
                    <th>Description</th>
                    <th>Pack / unit</th>
                    <th className={`kf-table__num${sort === "spend" ? " is-sorted" : ""}`}>
                      <span>Annual $</span>
                      {sort === "spend" ? <ArrowDown size={14} strokeWidth={1.5} /> : null}
                    </th>
                    <th className={`kf-table__num${sort === "lines" ? " is-sorted" : ""}`}>
                      <span>Lines</span>
                      {sort === "lines" ? <ArrowDown size={14} strokeWidth={1.5} /> : null}
                    </th>
                    <th className={sort === "last_seen" ? "is-sorted" : ""}>
                      <span>Last purchase</span>
                      {sort === "last_seen" ? <ArrowDown size={14} strokeWidth={1.5} /> : null}
                    </th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const vendorName = vendorNameById.get(r.vendor_id) ?? r.vendor_id;
                    const twinParent = r.duplicate_of_id ? twinParentById.get(r.duplicate_of_id) : null;
                    return (
                      <RowLink key={r.id} href={rowHref(r.id, p, seg, q, sort, pageSize)} rowId={r.id}>
                        <td title={vendorName}><div className="kf-cell-ellipsis kf-cell-strong">{vendorName}</div></td>
                        <td>
                          {r.item_number ? (
                            <span className="kf-cell-ellipsis">{r.item_number}</span>
                          ) : (
                            <span className="kf-cell-ellipsis kf-muted">none</span>
                          )}
                        </td>
                        <td title={r.name}>
                          <div className="kf-desc">
                            <span className="kf-desc__text">{r.name}</span>
                            {r.catch_weight ? (
                              <span className="kf-flag kf-flag--warn" title="Priced by actual weight">
                                <Scale size={14} strokeWidth={1.5} />
                              </span>
                            ) : null}
                            {twinParent ? (
                              <span
                                className="kf-flag kf-flag--twin"
                                title={`Twin of #${twinParent.item_number ?? "?"}`}
                              >
                                <Copy size={14} strokeWidth={1.5} />
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <div className="kf-cell-ellipsis">
                            {r.pack_text ?? "-"}
                            <span className="kf-muted"> / {r.billed_unit ?? "-"}</span>
                          </div>
                        </td>
                        <td className="kf-table__num"><strong>${fmtUsdLong(Number(r.usd_12m ?? 0)).replace(/^\$/, "")}</strong></td>
                        <td className="kf-table__num">{fmtCount(Number(r.lines_12m ?? 0))}</td>
                        <td>{r.last_seen ? fmtDate(r.last_seen) : "-"}</td>
                        <td><StatusChip row={r} /></td>
                      </RowLink>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8}>
                      <div className="kf-pager-foot">
                        <span>Showing {fmtCount(from)}-{fmtCount(to)} of {fmtCount(total)}</span>
                        <Pager page={page} last={last} params={p} seg={seg} q={q} sort={sort} pageSize={pageSize} />
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <ul className="kf-cards kf-only-phone">
              {items.map((r) => {
                const vendorName = vendorNameById.get(r.vendor_id) ?? r.vendor_id;
                const twinParent = r.duplicate_of_id ? twinParentById.get(r.duplicate_of_id) : null;
                const href = rowHref(r.id, p, seg, q, sort, pageSize);
                return (
                  <li key={r.id}>
                    <a href={href} className="kf-cards__item">
                      <div className="kf-cards__head">
                        <span className="kf-cards__vendor">{vendorName}</span>
                        <span className="kf-cards__num">{r.item_number ?? "none"}</span>
                      </div>
                      <div className="kf-cards__name">{r.name}</div>
                      <div className="kf-cards__meta">
                        <span>${fmtUsdLong(Number(r.usd_12m ?? 0)).replace(/^\$/, "")} / 12m</span>
                        <span>{fmtCount(Number(r.lines_12m ?? 0))} lines</span>
                        <span>{r.last_seen ? fmtDate(r.last_seen) : "-"}</span>
                      </div>
                      <div className="kf-cards__chips">
                        <StatusChip row={r} />
                        {r.catch_weight ? (
                          <span className="kf-flag kf-flag--warn" title="Priced by actual weight">
                            <Scale size={14} strokeWidth={1.5} />
                          </span>
                        ) : null}
                        {twinParent ? (
                          <span
                            className="kf-flag kf-flag--twin"
                            title={`Twin of #${twinParent.item_number ?? "?"}`}
                          >
                            <Copy size={14} strokeWidth={1.5} />
                          </span>
                        ) : null}
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {p.drawer ? (
        <VendorItemDrawer
          id={p.drawer}
          closeHref={buildHref({ ...p, drawer: undefined }, seg, q, sort, pageSize)}
          vendorNameById={Object.fromEntries(vendorNameById)}
        />
      ) : null}
    </div>
  );
}

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

function StatusLegend() {
  return (
    <div className="kf-table-legend" aria-label="Status legend">
      <span className="kf-table-legend__label">Link status</span>
      <span className="kf-pill kf-pill--info">Unlinked</span>
      <span className="kf-pill kf-pill--info">Proposed</span>
      <span className="kf-pill kf-pill--good">Linked</span>
      <span className="kf-pill kf-pill--muted">Rejected</span>
      <span className="kf-table-legend__sep" />
      <span className="kf-flag kf-flag--warn" aria-hidden><Scale size={12} strokeWidth={1.5} /></span>
      <span className="kf-table-legend__hint">Priced by actual weight</span>
      <span className="kf-flag kf-flag--twin" aria-hidden><Copy size={12} strokeWidth={1.5} /></span>
      <span className="kf-table-legend__hint">Twin of another number</span>
    </div>
  );
}

function Pager({
  page,
  last,
  params,
  seg,
  q,
  sort,
  pageSize,
}: {
  page: number;
  last: number;
  params: Params;
  seg: StatusSeg;
  q: string;
  sort: SortKey;
  pageSize: number;
}) {
  const prev = buildHref({ ...params, page: String(Math.max(0, page - 1)) }, seg, q, sort, pageSize);
  const next = buildHref({ ...params, page: String(Math.min(last, page + 1)) }, seg, q, sort, pageSize);
  const prevDisabled = page === 0;
  const nextDisabled = page >= last;
  return (
    <div className="kf-pager" aria-label="Page navigation">
      <a
        href={prev}
        className={`kf-pager__btn${prevDisabled ? " is-disabled" : ""}`}
        aria-disabled={prevDisabled}
        aria-label="Previous page"
      >
        <ChevronLeft size={16} strokeWidth={1.5} />
      </a>
      <span className="kf-pager__loc">
        {fmtCount(page + 1)} <span className="kf-muted">of {fmtCount(Math.max(1, last + 1))}</span>
      </span>
      <a
        href={next}
        className={`kf-pager__btn${nextDisabled ? " is-disabled" : ""}`}
        aria-disabled={nextDisabled}
        aria-label="Next page"
      >
        <ChevronRight size={16} strokeWidth={1.5} />
      </a>
    </div>
  );
}

function EmptyRow() {
  return (
    <div className="kf-empty kf-table-empty">
      <div>
        <div className="kf-empty__title">No items match</div>
        <div className="kf-empty__body">Clear the search or widen the segment.</div>
      </div>
      <a href="/stockpot/ingredients/vendor-items" className="kf-btn kf-btn--soft kf-btn--sm">
        Clear filters
      </a>
    </div>
  );
}

function rowHref(id: string, p: Params, seg: StatusSeg, q: string, sort: SortKey, pageSize: number): string {
  return buildHref({ ...p, drawer: id }, seg, q, sort, pageSize);
}

function buildHref(p: Params, seg: StatusSeg, q: string, sort: SortKey, pageSize: number): string {
  const u = new URLSearchParams();
  if (p.vendor && p.vendor !== "all") u.set("vendor", p.vendor);
  if (seg !== "all") u.set("status", seg);
  if (q.length > 0) u.set("q", q);
  if (p.page && p.page !== "0") u.set("page", p.page);
  if (sort !== "spend") u.set("sort", sort);
  if (pageSize !== DEFAULT_PAGE_SIZE) u.set("per", String(pageSize));
  if (p.drawer) u.set("drawer", p.drawer);
  const qs = u.toString();
  return qs ? `?${qs}` : "?";
}
