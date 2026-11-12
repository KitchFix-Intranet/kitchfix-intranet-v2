"use client";

// N13: presentational client component for the Vendor items tab.
// All data loading happens in VendorItemsPage (server); this file
// never touches serviceClient, requireOwnerApi, applyCountableFilter
// or any fetch for mount-time data. The two fetches it DOES make are
// behaviour, not mount data:
//   1. navigation (router.push) when a chip / search / sort / pager
//      is used (no fetch; the URL changes and the server page refills);
//   2. /api/review/item inside ItemPanelById when the user clicks a
//      row (opens the shared item panel - same as the Ingredients tab).
//
// Chat-Claude can mount this component in isolation with sample rows
// and drive every surface; no Next async-server-component required.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong, monthsAgo } from "@/lib/fmt";
import { uomLabel } from "@/lib/ingredients/pack";
import { ItemPanelById } from "./ItemPanelById";
import "./vendor-items-tab.css";

// Every segment the two chip rows may select, one URL enum.
// 'unlinked' keeps its URL value (R7) even though the chip label is
// now "Not linked"; narrowing to link_status='none' happens server-
// side in VendorItemsPage's filter.
export type VendorSeg =
  | "all"
  | "unlinked"
  | "proposed"
  | "linked"
  | "retail"
  | "catch_weight"
  | "no_number"
  | "duplicates"
  | "not_food"
  | "archived";

export type SortKey = "spend" | "lines" | "last_seen";

export type LinkCell =
  | { kind: "duplicate"; main: string; sub: string }
  | { kind: "archived"; main: string; sub: string }
  | { kind: "one_off"; main: string; sub: string }
  | { kind: "not_food"; main: string; sub: string }
  | { kind: "retail"; main: string; sub: string }
  | { kind: "proposed"; main: string; sub: string }
  | { kind: "linked"; main: string; sub: string }
  | { kind: "rejected"; main: string; sub: string }
  | { kind: "not_linked"; main: string; sub: string };

export type VendorItemViewRow = {
  id: string;
  vendorName: string;
  itemNumber: string | null;
  name: string;
  catchWeight: boolean;
  twinOfNumber: string | null;
  link: LinkCell;
  packText: string | null;
  billedUnit: string | null;
  packMissing: boolean;
  perBase: number | null;
  perBaseUom: string | null;
  usd12m: number;
  lines12m: number;
  lastSeenISO: string | null;
  attention: boolean;
  isFood: boolean;
  status: string;
};

export type VendorSegCounts = Record<VendorSeg, number>;

export type VendorItemsViewProps = {
  rows: VendorItemViewRow[];
  vendors: Array<{ id: string; name: string }>;
  seg: VendorSeg;
  segCounts: VendorSegCounts;
  q: string;
  sort: SortKey;
  page: number;
  pageSize: number;
  total: number;
  from: number;
  to: number;
  openId: string | null;
  vendorFilterId: string;
};

const SORT_LABEL: Record<SortKey, string> = {
  spend: "Highest 12-month spend",
  lines: "Most lines",
  last_seen: "Most recently bought",
};

// Precedence from VendorItemDrawer / StatusChip, verbatim per §2b.
// Round 2 fix 9: "Not linked" is main WARN 800 + sub plain.
// Proposed keeps its own treatment (main navy + sub warn).
const LINK_SUB_WARN: Partial<Record<LinkCell["kind"], true>> = {
  proposed: true,
};
const LINK_MAIN_WARN: Partial<Record<LinkCell["kind"], true>> = {
  not_linked: true,
};
const LINK_MAIN_MUTED: Partial<Record<LinkCell["kind"], true>> = {
  archived: true,
  one_off: true,
  not_food: true,
  rejected: true,
};
// Round 2 fix 10 handles retail-with-no-ingredient in VendorItemsPage
// (shapeRow produces main "Retail" + sub "sold as-is"). This file
// renders whatever LinkCell comes in.

const CHIP_LABEL: Record<VendorSeg, string> = {
  all: "All",
  unlinked: "Not linked",
  proposed: "Proposed",
  linked: "Linked",
  retail: "Retail",
  catch_weight: "Catch weight",
  no_number: "No item number",
  duplicates: "Duplicates",
  not_food: "Not food",
  archived: "Archived",
};

export function VendorItemsView(props: VendorItemsViewProps) {
  const router = useRouter();
  const params = useSearchParams();

  // The server hands openId directly (so SSR title is correct). In
  // the browser, react to subsequent client-side changes.
  const liveOpenId = params.get("drawer") ?? props.openId;

  // Search input is controlled client-side; commit on Enter or Clear.
  const [search, setSearch] = useState(props.q);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSearch(props.q);
  }, [props.q]);

  const push = useCallback(
    (patch: Partial<Record<string, string | null>>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      // Reset the page on filter / sort / vendor / search changes.
      if (Object.keys(patch).some((k) => ["status", "vendor", "q", "sort"].includes(k))) {
        next.delete("page");
      }
      const qs = next.toString();
      router.push(qs ? `?${qs}` : "?");
    },
    [params, router],
  );

  function onSelectSeg(k: VendorSeg) {
    push({ status: k === "all" ? null : k });
  }
  function onSelectVendor(v: string) {
    push({ vendor: v === "all" ? null : v });
  }
  function onSelectSort(s: SortKey) {
    push({ sort: s === "spend" ? null : s });
  }
  function onSubmitSearch() {
    push({ q: search.trim() || null });
  }
  function onClearSearch() {
    setSearch("");
    push({ q: null });
    searchRef.current?.focus();
  }
  function onClearAll() {
    router.push("?");
  }
  function onPage(n: number) {
    push({ page: n === 0 ? null : String(n) });
  }
  function openRow(id: string) {
    try {
      sessionStorage.setItem("kf.drawer.from-row", id);
    } catch {
      /* non-fatal */
    }
    push({ drawer: id });
  }
  function closePanel() {
    push({ drawer: null });
    // Focus return on next paint: look up the row by data-row-id.
    requestAnimationFrame(() => {
      let fromRow: string | null = null;
      try {
        fromRow = sessionStorage.getItem("kf.drawer.from-row");
      } catch {
        /* non-fatal */
      }
      if (fromRow) {
        const el = document.querySelector<HTMLElement>(`[data-row-id="${fromRow}"]`);
        if (el) {
          el.focus();
          return;
        }
      }
      searchRef.current?.focus();
    });
  }

  const last = Math.max(0, Math.ceil(props.total / props.pageSize) - 1);
  const filtersActive =
    props.q.length > 0 ||
    props.seg !== "all" ||
    (props.vendorFilterId && props.vendorFilterId !== "all");

  return (
    <div className="kf-vi__page">
      {/* --- Toolbar ----------------------------------------- */}
      <div className="kf-vi__tools">
        <div className="kf-vi__tools-row">
          <label className="kf-vi__search">
            <Search size={16} strokeWidth={1.75} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => {
                const v = e.target.value;
                setSearch(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmitSearch();
                } else if (e.key === "Escape" && search.length > 0) {
                  e.preventDefault();
                  onClearSearch();
                }
              }}
              placeholder="Description or item number"
              aria-label="Filter vendor items"
            />
            {search ? (
              <button
                type="button"
                onClick={onClearSearch}
                aria-label="Clear search"
                style={{
                  position: "absolute",
                  right: "var(--sp-sp-2)",
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: "var(--sp-floor-corp)",
                  height: "var(--sp-floor-corp)",
                  background: "transparent",
                  border: 0,
                  color: "var(--sp-muted)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            ) : null}
          </label>
          <select
            className="kf-vi__vendor-select"
            value={props.vendorFilterId}
            onChange={(e) => {
              const v = e.target.value;
              onSelectVendor(v);
            }}
            aria-label="Filter by vendor"
          >
            <option value="all">All vendors</option>
            {props.vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>

        <div className="kf-vi__filters">
          <span className="kf-vi__filters-label">Link</span>
          <div className="kf-chip-row" role="radiogroup" aria-label="Link filter">
            <ChipButton active={props.seg === "all"} onClick={() => onSelectSeg("all")}>
              All <span>{fmtCount(props.segCounts.all)}</span>
            </ChipButton>
            <ChipButton
              active={props.seg === "unlinked"}
              warn
              onClick={() => onSelectSeg("unlinked")}
            >
              Not linked <span>{fmtCount(props.segCounts.unlinked)}</span>
            </ChipButton>
            <ChipButton active={props.seg === "proposed"} onClick={() => onSelectSeg("proposed")}>
              Proposed <span>{fmtCount(props.segCounts.proposed)}</span>
            </ChipButton>
            <ChipButton active={props.seg === "linked"} onClick={() => onSelectSeg("linked")}>
              Linked <span>{fmtCount(props.segCounts.linked)}</span>
            </ChipButton>
            <ChipButton active={props.seg === "retail"} onClick={() => onSelectSeg("retail")}>
              Retail <span>{fmtCount(props.segCounts.retail)}</span>
            </ChipButton>
          </div>

          <span className="kf-vi__filters-label">Show only</span>
          <div className="kf-chip-row" role="radiogroup" aria-label="Attribute filter">
            <ChipButton
              active={props.seg === "catch_weight"}
              onClick={() => onSelectSeg("catch_weight")}
            >
              Catch weight <span>{fmtCount(props.segCounts.catch_weight)}</span>
            </ChipButton>
            <ChipButton
              active={props.seg === "no_number"}
              onClick={() => onSelectSeg("no_number")}
            >
              No item number <span>{fmtCount(props.segCounts.no_number)}</span>
            </ChipButton>
            <ChipButton
              active={props.seg === "duplicates"}
              onClick={() => onSelectSeg("duplicates")}
            >
              Duplicates <span>{fmtCount(props.segCounts.duplicates)}</span>
            </ChipButton>
            <ChipButton
              active={props.seg === "not_food"}
              onClick={() => onSelectSeg("not_food")}
            >
              Not food <span>{fmtCount(props.segCounts.not_food)}</span>
            </ChipButton>
            <ChipButton
              active={props.seg === "archived"}
              onClick={() => onSelectSeg("archived")}
            >
              Archived <span>{fmtCount(props.segCounts.archived)}</span>
            </ChipButton>
          </div>
        </div>
      </div>

      {/* --- Card ------------------------------------------- */}
      <section className="kf-vi__card" aria-label="Vendor items">
        {props.rows.length === 0 ? (
          <div className="kf-vi__card-head">
            <div className="kf-vi__card-head-title">
              <h3>0 items match</h3>
            </div>
          </div>
        ) : (
          <CardBar
            title
            total={props.total}
            from={props.from}
            to={props.to}
            sort={props.sort}
            onSelectSort={onSelectSort}
            page={props.page}
            last={last}
            onPage={onPage}
          />
        )}

        {props.rows.length === 0 ? (
          <EmptyBlock
            q={props.q}
            seg={props.seg}
            vendorName={
              props.vendorFilterId && props.vendorFilterId !== "all"
                ? props.vendors.find((v) => v.id === props.vendorFilterId)?.name ?? null
                : null
            }
            onClearAll={onClearAll}
          />
        ) : (
          <table className="kf-vi__table">
            {/* Round 2 fix 3: ONE source for the stacked block. The
                table renders at every width; the container query
                @container vi-card (max-width: 1040px) swaps the
                colgroup off and lays each <tr> as a grid. Phone (card
                is the viewport) falls inside the narrow branch
                automatically - no separate phone list. */}
            <colgroup>
              {/* Col widths live in vendor-items-tab.css so the
                  @container query can collapse cols 1 + 7 on the
                  middle tier. The size order (180 / flex / 208 /
                  148 / 100 / 104 / 112) is unchanged at the wide
                  tier. */}
              <col />
              <col />
              <col />
              <col />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Item</th>
                <th>Linked to</th>
                <th>Pack</th>
                <th className="kf-vi__num">Price</th>
                <th className="kf-vi__num">12 mo</th>
                <th>Last bought</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <TableRow key={r.id} row={r} onOpen={openRow} />
              ))}
            </tbody>
          </table>
        )}

        {props.rows.length === 0 ? null : (
          <CardBar
            footer
            total={props.total}
            from={props.from}
            to={props.to}
            sort={props.sort}
            onSelectSort={onSelectSort}
            page={props.page}
            last={last}
            onPage={onPage}
          />
        )}
      </section>

      {/* --- Item panel (opens on row click) ----------------- */}
      <ItemPanelById
        itemId={liveOpenId}
        onClose={closePanel}
        showStatusActions
      />
    </div>
  );
}

function ChipButton({
  active,
  warn = false,
  onClick,
  children,
}: {
  active: boolean;
  warn?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`kf-chip${warn ? " kf-chip--warn" : ""}${active ? " kf-chip--on" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CardBar({
  title: isTitle = false,
  footer: isFooter = false,
  total,
  from,
  to,
  sort,
  onSelectSort,
  page,
  last,
  onPage,
}: {
  title?: boolean;
  footer?: boolean;
  total: number;
  from: number;
  to: number;
  sort: SortKey;
  onSelectSort: (s: SortKey) => void;
  page: number;
  last: number;
  onPage: (n: number) => void;
}) {
  return (
    <div className={isFooter ? "kf-vi__card-foot" : "kf-vi__card-head"}>
      {isTitle ? (
        <div className="kf-vi__card-head-title">
          <h3>Vendor items</h3>
          <span className="kf-vi__card-head-sub">
            <b>{fmtCount(total)}</b> items · showing <b>{fmtCount(from)}</b> to <b>{fmtCount(to)}</b>
          </span>
        </div>
      ) : (
        <span className="kf-vi__card-foot-sub">
          Showing <b>{fmtCount(from)}</b> to <b>{fmtCount(to)}</b> of <b>{fmtCount(total)}</b>
        </span>
      )}
      <div className={isFooter ? "kf-vi__card-foot-right" : "kf-vi__card-head-right"}>
        {isTitle ? (
          <select
            className="kf-vi__sort"
            value={sort}
            onChange={(e) => {
              const s = e.target.value as SortKey;
              onSelectSort(s);
            }}
            aria-label="Sort order"
          >
            <option value="spend">{SORT_LABEL.spend}</option>
            <option value="lines">{SORT_LABEL.lines}</option>
            <option value="last_seen">{SORT_LABEL.last_seen}</option>
          </select>
        ) : null}
        <Pager page={page} last={last} onPage={onPage} />
      </div>
    </div>
  );
}

function Pager({ page, last, onPage }: { page: number; last: number; onPage: (n: number) => void }) {
  return (
    <div className="kf-vi__pager" aria-label="Page navigation">
      <button
        type="button"
        className="kf-vi__pager-btn"
        disabled={page <= 0}
        onClick={() => onPage(Math.max(0, page - 1))}
        aria-label="Previous page"
      >
        <ChevronLeft size={16} strokeWidth={1.5} />
      </button>
      <span className="kf-vi__pager-loc">
        {fmtCount(page + 1)} of {fmtCount(Math.max(1, last + 1))}
      </span>
      <button
        type="button"
        className="kf-vi__pager-btn"
        disabled={page >= last}
        onClick={() => onPage(Math.min(last, page + 1))}
        aria-label="Next page"
      >
        <ChevronRight size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function EmptyBlock({
  q,
  seg,
  vendorName,
  onClearAll,
}: {
  q: string;
  seg: VendorSeg;
  vendorName: string | null;
  onClearAll: () => void;
}) {
  // Round 2 fix 6: name only the parts in force, using the chip's
  // label (not its URL key). Pattern: Nothing for "kombucha" in
  // Not linked at Sysco.
  const parts: string[] = [];
  if (q) parts.push(`for "${q}"`);
  if (seg !== "all") parts.push(`in ${CHIP_LABEL[seg]}`);
  if (vendorName) parts.push(`at ${vendorName}`);
  const body = parts.length === 0 ? "Nothing in the full set." : `Nothing ${parts.join(" ")}.`;
  return (
    <div className="kf-vi__empty">
      <div className="kf-vi__empty-body">{body}</div>
      <button type="button" className="kf-btn kf-btn--line kf-btn--sm" onClick={onClearAll}>
        Clear search and filters
      </button>
    </div>
  );
}

function TableRow({
  row,
  onOpen,
}: {
  row: VendorItemViewRow;
  onOpen: (id: string) => void;
}) {
  return (
    <tr
      className={`kf-vi__row${row.attention ? " kf-vi__row--att" : ""}`}
      role="link"
      tabIndex={0}
      data-row-id={row.id}
      onClick={() => onOpen(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(row.id);
        }
      }}
    >
      <td>
        <div className="kf-vi__cell-main">{row.vendorName}</div>
        <div className="kf-vi__cell-sub">
          {row.itemNumber ? `#${row.itemNumber}` : "no item #"}
        </div>
      </td>
      <td>
        <div className="kf-vi__cell-main">{row.name}</div>
        {(row.catchWeight || row.twinOfNumber) ? (
          <div className="kf-vi__cell-sub kf-vi__cell-sub--warn">
            {[row.catchWeight ? "catch weight" : null, row.twinOfNumber ? `twin of #${row.twinOfNumber}` : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
        ) : null}
        {/* N13 round 3 fix 1: vendor folds into the Item cell at
            card < 1040 (middle + narrow tiers). CSS hides this sub
            at the wide tier where the Vendor column carries it. */}
        <div className="kf-vi__cell-sub kf-vi__cell-sub--fold-vendor">
          {row.vendorName}
          {row.itemNumber ? ` · #${row.itemNumber}` : ""}
        </div>
      </td>
      <td>
        <div
          className={`kf-vi__cell-main${LINK_MAIN_MUTED[row.link.kind] ? " kf-vi__cell-main--muted" : ""}${
            LINK_MAIN_WARN[row.link.kind] ? " kf-vi__cell-main--warn" : ""
          }${
            row.link.kind === "linked" || row.link.kind === "proposed" || row.link.kind === "retail"
              ? " kf-vi__cell-main--navy"
              : ""
          }`}
        >
          {row.link.main}
        </div>
        <div className={`kf-vi__cell-sub${LINK_SUB_WARN[row.link.kind] ? " kf-vi__cell-sub--warn" : ""}`}>
          {row.link.sub}
        </div>
      </td>
      <td>
        {row.packMissing ? (
          <div className="kf-vi__cell-main kf-vi__cell-sub--warn">No pack read</div>
        ) : (
          <div className="kf-vi__cell-main">{row.packText}</div>
        )}
        <div className="kf-vi__cell-sub">
          {row.billedUnit ? `billed by the ${uomLabel(row.billedUnit) || row.billedUnit}` : "billed unit unknown"}
        </div>
      </td>
      <td className="kf-vi__num">
        {row.perBase != null ? (
          <>
            <div className="kf-vi__cell-main kf-vi__cell-main--strong">{fmtUsd(row.perBase)}</div>
            <div className="kf-vi__cell-sub">per {uomLabel(row.perBaseUom) || row.perBaseUom || "unit"}</div>
          </>
        ) : (
          <>
            <div className="kf-vi__cell-main kf-vi__cell-main--muted">-</div>
            <div className="kf-vi__cell-sub">needs a pack</div>
          </>
        )}
      </td>
      <td className="kf-vi__num">
        <div className="kf-vi__cell-main kf-vi__cell-main--strong">{fmtUsdLong(row.usd12m)}</div>
        <div className="kf-vi__cell-sub">
          {fmtCount(row.lines12m)} line{row.lines12m === 1 ? "" : "s"}
        </div>
        {/* N13 round 3 fix 1: last-bought folds into the 12 mo cell
            at the MIDDLE tier only. CSS hides at wide + narrow. */}
        {row.lastSeenISO ? (
          <div className="kf-vi__cell-sub kf-vi__cell-sub--fold-lastbot">
            {fmtDate(row.lastSeenISO)}
            {staleMonthsSuffix(row.lastSeenISO)}
          </div>
        ) : null}
      </td>
      <td>
        {row.lastSeenISO ? (
          <>
            {/* Wide tier: date as main + mo-ago sub (current column
                shape). Hidden at middle (folded into 12 mo cell) and
                at narrow (replaced by the compact micro below). */}
            <div className="kf-vi__cell-main kf-vi__lb-full">{fmtDate(row.lastSeenISO)}</div>
            <div className="kf-vi__lb-full">{monthsAgoIfStale(row.lastSeenISO)}</div>
            {/* Narrow tier: standalone micro below the pair rows per
                frame D. Hidden at wide + middle. */}
            <div className="kf-vi__cell-sub kf-vi__lb-compact">
              last bought {fmtDate(row.lastSeenISO)}
              {staleMonthsSuffix(row.lastSeenISO)}
            </div>
          </>
        ) : (
          <div className="kf-vi__cell-main kf-vi__cell-main--muted">-</div>
        )}
      </td>
    </tr>
  );
}

function monthsAgoIfStale(iso: string) {
  const m = monthsAgo(iso);
  if (m == null || m < 3) return null;
  return <div className="kf-vi__cell-sub kf-vi__cell-sub--warn">{m} mo ago</div>;
}

// N13 round 3 fix 1 + 2: inline form of the stale marker used by
// the middle-tier fold and the narrow-tier last-bought row -
// ` · {m} mo ago` in warn when the item is 3+ months old, nothing
// otherwise.
function staleMonthsSuffix(iso: string) {
  const m = monthsAgo(iso);
  if (m == null || m < 3) return null;
  return <span className="kf-vi__cell-sub--warn"> · {m} mo ago</span>;
}

// Round 2 fix 3: PhoneBlock deleted. The table's @container narrow
// branch handles both phone and narrow-detail-desktop.
