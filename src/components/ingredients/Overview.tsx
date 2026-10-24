// Overview tab for the Ingredients tool.
//
// Reads live rows from pr_vendor_items + pr_ingredients + pr_intake_runs +
// pr_vendors + pr_price_observations. On day one every item has
// link_status='none' and no ingredients are named, so dollars_linked is zero and
// Ingredients named is 0 - that is the expected starting state.

import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { Tabs } from "./Tabs";
import { RunIntakeButton } from "./RunIntakeButton";
import "./ingredients.css";

type VendorItemRow = {
  id: string;
  vendor_id: string;
  item_number_norm: string | null;
  is_food: boolean | null;
  status: string;
  link_status: string;
  pack_state: string;
  catch_weight: boolean;
  usd_12m: number | null;
  usd: number | null;
  accounts: string[] | null;
};

type IntakeRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed";
  counts: Record<string, unknown> | null;
  mode: string;
};

type VendorRow = { id: string; name: string };

type Totals = {
  food_items_active: number;
  food_items_total: number;
  food_items_with_number: number;
  food_items_waiting: number;
  food_items_waiting_usd: number;
  food_dollars_total: number;
  food_dollars_linked: number;
  packs_clean: number;
  catch_weight_items: number;
  no_number_items: number;
  no_number_dollars: number;
  needs_review_lines: number;
  twins_count: number;
  by_account: Map<string, { food: number; linked: number }>;
  by_vendor: Map<string, { food: number; linked: number }>;
};

function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}K`;
  return `${sign}${Math.round(abs)}`;
}

function pct(num: number, den: number): string {
  if (den <= 0) return "0%";
  return `${Math.round((num / den) * 100)}%`;
}

async function loadTotals(): Promise<{
  totals: Totals;
  lastRun: IntakeRun | null;
  vendors: VendorRow[];
  ingredientsNamed: number;
  intakeRunsTotal: number;
}> {
  const client = serviceClient();

  const [itemsRes, runsRes, vendorsRes, ingredientsRes, runCountRes, needsReviewLinesRes] = await Promise.all([
    client
      .from("pr_vendor_items")
      .select("id,vendor_id,item_number_norm,is_food,status,link_status,pack_state,catch_weight,usd_12m,usd,accounts"),
    client
      .from("pr_intake_runs")
      .select("id,started_at,finished_at,status,counts,mode")
      .order("started_at", { ascending: false })
      .limit(1),
    client.from("pr_vendors").select("id,name"),
    client.from("pr_ingredients").select("id", { count: "exact", head: true }).eq("status", "active"),
    client.from("pr_intake_runs").select("id", { count: "exact", head: true }),
    client.from("pr_price_observations").select("id", { count: "exact", head: true }).eq("needs_review", true),
  ]);

  if (itemsRes.error) throw itemsRes.error;
  if (vendorsRes.error) throw vendorsRes.error;

  const items = (itemsRes.data ?? []) as VendorItemRow[];
  const vendors = (vendorsRes.data ?? []) as VendorRow[];
  const lastRun = ((runsRes.data ?? [])[0] ?? null) as IntakeRun | null;

  const totals: Totals = {
    food_items_active: 0,
    food_items_total: 0,
    food_items_with_number: 0,
    food_items_waiting: 0,
    food_items_waiting_usd: 0,
    food_dollars_total: 0,
    food_dollars_linked: 0,
    packs_clean: 0,
    catch_weight_items: 0,
    no_number_items: 0,
    no_number_dollars: 0,
    needs_review_lines: needsReviewLinesRes.count ?? 0,
    twins_count: 0,
    by_account: new Map(),
    by_vendor: new Map(),
  };

  for (const it of items) {
    if (it.status === "duplicate") totals.twins_count += 1;
    if (it.pack_state === "ok") totals.packs_clean += 1;

    const isFood = !!it.is_food && (it.status === "active" || it.status === "resale");
    if (!isFood) continue;

    totals.food_items_total += 1;
    totals.food_items_active += 1;
    if (it.item_number_norm != null) totals.food_items_with_number += 1;
    if (it.catch_weight) totals.catch_weight_items += 1;
    if (it.item_number_norm == null) {
      totals.no_number_items += 1;
      totals.no_number_dollars += Number(it.usd_12m ?? 0);
    }

    if (it.link_status === "none" || it.link_status === "proposed") {
      totals.food_items_waiting += 1;
      totals.food_items_waiting_usd += Number(it.usd_12m ?? 0);
    }

    const u12 = Number(it.usd_12m ?? 0);
    totals.food_dollars_total += u12;
    if (it.link_status === "confirmed") totals.food_dollars_linked += u12;

    for (const acct of it.accounts ?? []) {
      const row = totals.by_account.get(acct) ?? { food: 0, linked: 0 };
      row.food += u12 / Math.max(1, (it.accounts ?? []).length);
      if (it.link_status === "confirmed") row.linked += u12 / Math.max(1, (it.accounts ?? []).length);
      totals.by_account.set(acct, row);
    }

    const vrow = totals.by_vendor.get(it.vendor_id) ?? { food: 0, linked: 0 };
    vrow.food += u12;
    if (it.link_status === "confirmed") vrow.linked += u12;
    totals.by_vendor.set(it.vendor_id, vrow);
  }

  return {
    totals,
    lastRun,
    vendors,
    ingredientsNamed: ingredientsRes.count ?? 0,
    intakeRunsTotal: runCountRes.count ?? 0,
  };
}

export async function Overview() {
  const { totals, lastRun, vendors, ingredientsNamed, intakeRunsTotal } = await loadTotals();
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));

  const topVendors = Array.from(totals.by_vendor.entries())
    .sort((a, b) => b[1].food - a[1].food)
    .slice(0, 10);

  const bySite = Array.from(totals.by_account.entries()).sort((a, b) => b[1].food - a[1].food);

  const lastRunLabel = lastRun
    ? `${new Date(lastRun.started_at).toLocaleString()} - ${lastRun.status}`
    : "No intake run yet";

  return (
    <div className="kf-ing">
      <header className="kf-ing__header">
        <span className="kf-eyebrow">Culinary office - the ingredient database</span>
        <h2>Ingredients</h2>
        <p className="kf-ing__kicker">
          What we buy, in our words. Invoice lines become vendor items, vendor
          items link to one ingredient, and the price a recipe sees is the
          company price with a date on it. Nothing enters without a human saying so.
        </p>
      </header>

      <Tabs active="overview" />

      <section className="kf-ing__status" aria-label="Intake status">
        <div className="kf-ing__status-row">
          <div>
            <span className="kf-ing__status-label">Last intake</span>
            <span className="kf-ing__status-value">{lastRunLabel}</span>
          </div>
          <RunIntakeButton />
        </div>
        <p className="kf-ing__status-sub">{intakeRunsTotal} total runs</p>
      </section>

      <section className="kf-tiles" aria-label="Headline numbers">
        <article className="kf-tile kf-tile--lead">
          <span className="kf-tile__label">Food dollars linked (12m)</span>
          <span className="kf-tile__value">{pct(totals.food_dollars_linked, totals.food_dollars_total)}</span>
          <span className="kf-tile__sub">
            ${usd(totals.food_dollars_linked)} / ${usd(totals.food_dollars_total)}
          </span>
        </article>
        <article className="kf-tile">
          <span className="kf-tile__label">Vendor items (food, active)</span>
          <span className="kf-tile__value">{totals.food_items_active.toLocaleString()}</span>
          <span className="kf-tile__sub">{totals.food_items_with_number.toLocaleString()} have an item number</span>
        </article>
        <article className="kf-tile">
          <span className="kf-tile__label">Packs read</span>
          <span className="kf-tile__value">{totals.packs_clean.toLocaleString()}</span>
          <span className="kf-tile__sub">Parser arrives in step 3</span>
        </article>
        <article className="kf-tile">
          <span className="kf-tile__label">Waiting for you</span>
          <span className="kf-tile__value">{totals.food_items_waiting.toLocaleString()}</span>
          <span className="kf-tile__sub">${usd(totals.food_items_waiting_usd)} unlinked (12m)</span>
        </article>
        <article className="kf-tile">
          <span className="kf-tile__label">Ingredients named</span>
          <span className="kf-tile__value">{ingredientsNamed.toLocaleString()}</span>
          <span className="kf-tile__sub">Naming lands in step 5</span>
        </article>
      </section>

      <section className="kf-coverage" aria-label="Coverage by site">
        <h3>Coverage by site</h3>
        {bySite.length === 0 ? (
          <div className="kf-state">
            <div className="kf-state__title">No food dollars yet</div>
            <div className="kf-state__body">Run intake and the per-site meters will fill.</div>
          </div>
        ) : (
          <ul className="kf-meters">
            {bySite.map(([acct, { food, linked }]) => (
              <li key={acct}>
                <div className="kf-meter__row">
                  <span className="kf-meter__name">{acct}</span>
                  <span className="kf-meter__nums">
                    ${usd(linked)} / ${usd(food)}
                  </span>
                </div>
                <div className="kf-meter__bar">
                  <div
                    className="kf-meter__fill"
                    style={{ width: pct(linked, food) }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="kf-coverage" aria-label="Coverage by vendor">
        <h3>Coverage by vendor (top 10 by 12-month dollars)</h3>
        {topVendors.length === 0 ? (
          <div className="kf-state">
            <div className="kf-state__title">No vendors with food dollars yet</div>
            <div className="kf-state__body">Run intake and this list will populate.</div>
          </div>
        ) : (
          <ul className="kf-meters">
            {topVendors.map(([vendorId, { food, linked }]) => (
              <li key={vendorId}>
                <div className="kf-meter__row">
                  <span className="kf-meter__name">{vendorNameById.get(vendorId) ?? vendorId}</span>
                  <span className="kf-meter__nums">
                    ${usd(linked)} / ${usd(food)}
                  </span>
                </div>
                <div className="kf-meter__bar">
                  <div className="kf-meter__fill" style={{ width: pct(linked, food) }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="kf-health" aria-label="Data health">
        <article className="kf-card">
          <header><span className="kf-eyebrow">Data health</span><h3>What the lines look like</h3></header>
          <dl className="kf-kv">
            <div><dt>Lines with no item number</dt><dd>{totals.no_number_items.toLocaleString()} items / ${usd(totals.no_number_dollars)}</dd></div>
            <div><dt>Lines flagged on the invoice</dt><dd>{totals.needs_review_lines.toLocaleString()}</dd></div>
            <div><dt>Catch-weight items</dt><dd>{totals.catch_weight_items.toLocaleString()}</dd></div>
            <div><dt>Items with pack text</dt><dd>{totals.packs_clean.toLocaleString()} parsed</dd></div>
            <div><dt>Twins found</dt><dd>{totals.twins_count.toLocaleString()}</dd></div>
            <div><dt>Last intake</dt><dd>{lastRunLabel}</dd></div>
          </dl>
          <footer className="kf-card__foot">
            <Link href="/stockpot/ingredients/vendor-items" className="kf-link">
              Open vendor items -&gt;
            </Link>
          </footer>
        </article>
      </section>
    </div>
  );
}
