// Vendor item drawer. Server-rendered on ?drawer=<id>; wrapped in a client
// <DrawerFrame> that handles mount/exit animations, Escape close, focus trap
// and focus restore to the originating row.

import type { ReactNode } from "react";
import { Archive, Scale } from "lucide-react";
import { serviceClient } from "@/lib/supabase/service";
import { fmtCount, fmtDate, fmtUsd, fmtUsdLong, timeAgo } from "@/lib/fmt";
import { humanizeKind } from "@/lib/humanizeKind";
import { DrawerFrame } from "./DrawerFrame";
import { ItemStatusActions } from "./ItemStatusActions";
import "./drawer.css";

type Props = {
  id: string;
  closeHref: string;
  vendorNameById: Record<string, string>;
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  archived: "Archived",
  one_off: "One off",
  not_food: "Not food",
  resale: "Resale",
  duplicate: "Duplicate",
};
const LINK_LABELS: Record<string, string> = {
  none: "Unlinked",
  proposed: "Proposed",
  confirmed: "Linked",
  rejected: "Rejected",
};
function humanizeStatus(s: string): string { return STATUS_LABELS[s] ?? s; }
function humanizeLinkStatus(s: string): string { return LINK_LABELS[s] ?? s; }
function renderPack(packText: string | null, packState: string): ReactNode {
  if (packText && packText.trim().length > 0) return packText;
  if (packState === "ok") return "-";
  return <span className="kf-muted">unparsed</span>;
}

type Item = {
  id: string;
  vendor_id: string;
  item_number: string | null;
  item_number_norm: string | null;
  name: string;
  description_key: string;
  pack_text: string | null;
  pack_state: string;
  billed_unit: string | null;
  catch_weight: boolean;
  is_food: boolean | null;
  food_reason: string | null;
  status: string;
  link_status: string;
  duplicate_of_id: string | null;
  usd: number | null;
  usd_12m: number | null;
  lines: number | null;
  lines_12m: number | null;
  accounts: string[] | null;
  first_seen: string | null;
  last_seen: string | null;
  needs_review_lines: number | null;
};

type ObsRow = {
  account_key: string;
  invoice_date: string | null;
  unit_price: number | null;
  quantity: number | null;
  extended_price: number | null;
};

type EventRow = {
  id: string;
  kind: string;
  at: string;
  actor: string | null;
  note: string | null;
};

type AliasRow = { description: string; count: number; last_seen: string | null };

export async function VendorItemDrawer({ id, closeHref, vendorNameById }: Props) {
  const client = serviceClient();
  const [itemRes, aliasesRes, obsRes, eventsRes] = await Promise.all([
    client
      .from("pr_vendor_items")
      .select(
        "id,vendor_id,item_number,item_number_norm,name,description_key,pack_text,pack_state,billed_unit,catch_weight,is_food,food_reason,status,link_status,duplicate_of_id,usd,usd_12m,lines,lines_12m,accounts,first_seen,last_seen,needs_review_lines"
      )
      .eq("id", id)
      .maybeSingle(),
    client
      .from("pr_vendor_item_aliases")
      .select("description,count,last_seen")
      .eq("vendor_item_id", id)
      .order("count", { ascending: false }),
    client
      .from("pr_price_observations")
      .select("account_key,invoice_date,unit_price,quantity,extended_price")
      .eq("vendor_item_id", id)
      .is("excluded_reason", null)
      .order("invoice_date", { ascending: false })
      .limit(1000),
    client
      .from("pr_events")
      .select("id,kind,at,note,actor")
      .eq("entity_type", "vendor_item")
      .eq("entity_id", id)
      .order("at", { ascending: false })
      .limit(50),
  ]);

  const item = itemRes.data as Item | null;
  const labelId = `kf-drawer-title-${id}`;

  if (!item) {
    return (
      <DrawerFrame closeHref={closeHref} labelledBy={labelId}>
        <div className="kf-drawer__head">
          <div>
            <span className="kf-eyebrow kf-eyebrow--plain">Vendor item</span>
            <h3 id={labelId}>Not found</h3>
          </div>
        </div>
        <div className="kf-empty">
          <div>
            <div className="kf-empty__title">Row missing</div>
            <div className="kf-empty__body">The item may have been archived or merged.</div>
          </div>
        </div>
      </DrawerFrame>
    );
  }

  const vendorName = vendorNameById[item.vendor_id] ?? item.vendor_id;

  const bySite = new Map<string, { lines: number; last_date: string | null; last_price: number | null; dollars: number }>();
  for (const o of (obsRes.data ?? []) as ObsRow[]) {
    const prior = bySite.get(o.account_key) ?? { lines: 0, last_date: null, last_price: null, dollars: 0 };
    prior.lines += 1;
    prior.dollars += Number(o.extended_price ?? 0);
    if (o.invoice_date && (!prior.last_date || o.invoice_date > prior.last_date)) {
      prior.last_date = o.invoice_date;
      prior.last_price = o.unit_price;
    }
    bySite.set(o.account_key, prior);
  }
  const sitesSorted = Array.from(bySite.entries()).sort((a, b) => b[1].dollars - a[1].dollars);

  const flagged = Number(item.needs_review_lines ?? 0);
  const lines12m = Number(item.lines_12m ?? 0);
  const allFlagged = sitesSorted.length === 0 && lines12m > 0 && flagged >= lines12m;

  return (
    <DrawerFrame closeHref={closeHref} labelledBy={labelId}>
      <div className="kf-drawer__head">
        <span className="kf-eyebrow kf-eyebrow--plain">
          {vendorName} - {item.item_number ? `#${item.item_number}` : "no number"}
        </span>
        <h3 id={labelId} className="kf-drawer__name">{item.name}</h3>
        <div className="kf-drawer__chips">
          <span className="kf-pill kf-pill--info">{humanizeLinkStatus(item.link_status)}</span>
          <span className="kf-pill kf-pill--muted">{humanizeStatus(item.status)}</span>
          <span className="kf-pill kf-pill--muted">{item.is_food ? "Food" : "Not food"}</span>
          {item.catch_weight ? (
            <span className="kf-pill kf-pill--warn">
              <Scale size={12} strokeWidth={1.5} />
              <span>Catch weight</span>
            </span>
          ) : null}
        </div>
      </div>

      <section className="kf-drawer__block" aria-label="Facts">
        <dl className="kf-facts">
          <div>
            <dt>12m spend</dt>
            <dd>${fmtUsdLong(Number(item.usd_12m ?? 0)).replace(/^\$/, "")}</dd>
          </div>
          <div>
            <dt>12m lines</dt>
            <dd>
              {fmtCount(lines12m)}
              {flagged > 0 ? (
                <span className="kf-facts__note kf-facts__note--warn">{fmtCount(flagged)} flagged on the invoice</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Pack</dt>
            <dd>{renderPack(item.pack_text, item.pack_state)}</dd>
          </div>
          <div>
            <dt>Billed unit</dt>
            <dd>{item.billed_unit ?? "-"}</dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd>{item.first_seen ? fmtDate(item.first_seen) : "-"}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{item.last_seen ? fmtDate(item.last_seen) : "-"}</dd>
          </div>
        </dl>
      </section>

      <section className="kf-drawer__block" aria-label="Spend by site">
        <header className="kf-drawer__block-head">
          <h4>Spend by site</h4>
          <small>12 months</small>
        </header>
        {sitesSorted.length === 0 && allFlagged ? (
          <p className="kf-note">
            {fmtCount(lines12m)} lines, all flagged on the invoice - nothing to price yet.
          </p>
        ) : sitesSorted.length === 0 ? (
          <p className="kf-muted">No observations recorded yet.</p>
        ) : (
          <table className="kf-table kf-table--compact">
            <thead>
              <tr>
                <th>Site</th>
                <th className="kf-table__num">Lines</th>
                <th>Last paid</th>
                <th>Last date</th>
              </tr>
            </thead>
            <tbody>
              {sitesSorted.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="kf-table__num">{fmtCount(v.lines)}</td>
                  <td>
                    {v.last_price != null
                      ? `${fmtUsd(Number(v.last_price))} / ${item.billed_unit ?? "unit"}`
                      : "-"}
                  </td>
                  <td>{v.last_date ? fmtDate(v.last_date) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="kf-drawer__block" aria-label="Description variants">
        <h4>Description variants</h4>
        {(aliasesRes.data?.length ?? 0) === 0 ? (
          <p className="kf-muted">No aliases recorded yet.</p>
        ) : (
          <ul className="kf-aliases">
            {(aliasesRes.data as AliasRow[]).map((a) => (
              <li key={a.description}>
                <span className="kf-aliases__desc">{a.description}</span>
                <span className="kf-aliases__count">x{fmtCount(a.count)}</span>
                <span className="kf-aliases__date">{a.last_seen ? fmtDate(a.last_seen) : "-"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="kf-drawer__block" aria-label="Ledger">
        <h4>Ledger</h4>
        {(eventsRes.data?.length ?? 0) === 0 ? (
          <div className="kf-empty kf-empty--inline">
            <div>
              <div className="kf-empty__title">No changes yet</div>
              <div className="kf-empty__body">
                Archiving, naming and link decisions will show here with who made them.
              </div>
            </div>
          </div>
        ) : (
          <ul className="kf-events">
            {(eventsRes.data as EventRow[]).map((e) => (
              <li key={e.id}>
                <span className="kf-events__kind">{humanizeKind(e.kind, 1)}</span>
                <span className="kf-events__who">{e.actor ?? "-"}</span>
                <time dateTime={e.at} title={fmtDate(e.at, "time")}>{timeAgo(e.at)}</time>
                {e.note ? <p>{e.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="kf-drawer__footer" aria-label="Actions">
        <ItemStatusActions id={item.id} status={item.status} closeHref={closeHref} />
      </footer>
    </DrawerFrame>
  );
}
