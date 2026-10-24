import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { ItemStatusActions } from "./ItemStatusActions";
import { X } from "lucide-react";
import type { StatusSeg } from "./Filters";
import "./drawer.css";

type Props = {
  id: string;
  params: Record<string, string | undefined>;
  seg: StatusSeg;
  q: string;
  vendorNameById: Record<string, string>;
};

function usdLong(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

function closeHref(params: Record<string, string | undefined>, seg: StatusSeg, q: string): string {
  const u = new URLSearchParams();
  if (params.vendor && params.vendor !== "all") u.set("vendor", params.vendor);
  if (seg !== "all") u.set("status", seg);
  if (q.length > 0) u.set("q", q);
  if (params.page && params.page !== "0") u.set("page", params.page);
  return "?" + u.toString();
}

export async function VendorItemDrawer({ id, params, seg, q, vendorNameById }: Props) {
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
      .select("id,kind,at,note,before,after,actor")
      .eq("entity_type", "vendor_item")
      .eq("entity_id", id)
      .order("at", { ascending: false })
      .limit(50),
  ]);

  const item = itemRes.data as
    | {
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
      }
    | null;

  const close = closeHref(params, seg, q);

  if (!item) {
    return (
      <>
        <Link href={close} className="kf-drawer__backdrop" aria-label="Close drawer" />
        <aside className="kf-drawer" aria-label="Vendor item">
          <div className="kf-drawer__head">
            <div><span className="kf-eyebrow">Vendor item</span><h3>Not found</h3></div>
            <Link href={close} className="kf-drawer__close"><X size={20} strokeWidth={1.5} /></Link>
          </div>
          <div className="kf-state"><div className="kf-state__title">Row missing</div><div className="kf-state__body">The item may have been archived or merged.</div></div>
        </aside>
      </>
    );
  }

  const vendorName = vendorNameById[item.vendor_id] ?? item.vendor_id;

  // Group observations by account.
  type ObsRow = { account_key: string; invoice_date: string | null; unit_price: number | null; quantity: number | null; extended_price: number | null };
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

  return (
    <>
      <Link href={close} className="kf-drawer__backdrop" aria-label="Close drawer" />
      <aside className="kf-drawer" aria-label="Vendor item">
        <div className="kf-drawer__head">
          <div>
            <span className="kf-eyebrow">{vendorName} - {item.item_number ?? "no number"}</span>
            <h3>{item.name}</h3>
          </div>
          <Link href={close} className="kf-drawer__close" aria-label="Close">
            <X size={20} strokeWidth={1.5} />
          </Link>
        </div>

        <section className="kf-drawer__facts">
          <dl className="kf-kv">
            <div><dt>Status</dt><dd>{item.status}</dd></div>
            <div><dt>Link status</dt><dd>{item.link_status}</dd></div>
            <div><dt>Food</dt><dd>{item.is_food ? `yes (${item.food_reason})` : `no (${item.food_reason})`}</dd></div>
            <div><dt>Pack</dt><dd>{item.pack_text ?? "-"} ({item.pack_state})</dd></div>
            <div><dt>Billed unit</dt><dd>{item.billed_unit ?? "-"}</dd></div>
            <div><dt>Catch weight</dt><dd>{item.catch_weight ? "yes" : "no"}</dd></div>
            <div><dt>12m dollars</dt><dd>${usdLong(Number(item.usd_12m ?? 0))}</dd></div>
            <div><dt>12m lines</dt><dd>{Number(item.lines_12m ?? 0).toLocaleString()}</dd></div>
            <div><dt>Lifetime</dt><dd>${usdLong(Number(item.usd ?? 0))} / {Number(item.lines ?? 0).toLocaleString()} lines</dd></div>
            <div><dt>First seen</dt><dd>{item.first_seen ?? "-"}</dd></div>
            <div><dt>Last seen</dt><dd>{item.last_seen ?? "-"}</dd></div>
            <div><dt>Lines flagged</dt><dd>{Number(item.needs_review_lines ?? 0).toLocaleString()}</dd></div>
          </dl>
        </section>

        <section className="kf-drawer__block">
          <h4>Description variants</h4>
          {(aliasesRes.data?.length ?? 0) === 0 ? (
            <p className="kf-muted">No aliases recorded yet.</p>
          ) : (
            <ul className="kf-aliases">
              {(aliasesRes.data as { description: string; count: number; last_seen: string | null }[]).map((a) => (
                <li key={a.description}>
                  <span>{a.description}</span>
                  <span className="kf-aliases__count">x{a.count}</span>
                  <span className="kf-aliases__date">{a.last_seen ?? "-"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="kf-drawer__block">
          <h4>By site</h4>
          {sitesSorted.length === 0 ? (
            <p className="kf-muted">No observations recorded yet.</p>
          ) : (
            <table className="kf-table">
              <thead><tr><th>Site</th><th className="kf-table__num">Lines</th><th>Last paid</th><th>Last date</th></tr></thead>
              <tbody>
                {sitesSorted.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="kf-table__num">{v.lines.toLocaleString()}</td>
                    <td>{v.last_price != null ? `$${Number(v.last_price).toFixed(2)}` : "-"}</td>
                    <td>{v.last_date ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="kf-drawer__block">
          <h4>Ledger</h4>
          {(eventsRes.data?.length ?? 0) === 0 ? (
            <p className="kf-muted">No events recorded yet.</p>
          ) : (
            <ul className="kf-events">
              {(eventsRes.data as { id: string; kind: string; at: string; note: string | null; actor: string | null }[]).map((e) => (
                <li key={e.id}>
                  <span className="kf-events__kind">{e.kind}</span>
                  <span className="kf-events__who">{e.actor ?? "-"}</span>
                  <time>{new Date(e.at).toLocaleString()}</time>
                  {e.note ? <p>{e.note}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="kf-drawer__actions">
          <ItemStatusActions id={item.id} status={item.status} />
        </section>
      </aside>
    </>
  );
}
