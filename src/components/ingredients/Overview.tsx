// Overview tab for the Ingredients tool.
//
// All vendor-item aggregation happens server-side via pr_v_overview_totals /
// pr_v_overview_by_account / pr_v_overview_by_vendor. The previous version did
// one unpaginated .select() on pr_vendor_items, which PostgREST capped at
// db-max-rows and silently truncated the tiles. The views aggregate every row
// in Postgres; the page reads scalars and sorted lists only.

import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { Tabs } from "./Tabs";
import { RunIntakeButton } from "./RunIntakeButton";
import "./ingredients.css";

type IntakeRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed";
  counts: Record<string, unknown> | null;
  mode: string;
};

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
  ingredientsNamed: number;
  intakeRunsTotal: number;
  bySite: Array<[string, { food: number; linked: number }]>;
  topVendors: Array<[string, { food: number; linked: number }]>;
}> {
  const client = serviceClient();

  const [totalsRes, byAcctRes, byVendorRes, runsRes, ingredientsRes, runCountRes, needsReviewLinesRes] =
    await Promise.all([
      client.from("pr_v_overview_totals").select("*").single(),
      client
        .from("pr_v_overview_by_account")
        .select("account_key,food,linked")
        .order("food", { ascending: false }),
      client
        .from("pr_v_overview_by_vendor")
        .select("vendor_id,vendor_name,food,linked")
        .order("food", { ascending: false })
        .limit(10),
      client
        .from("pr_intake_runs")
        .select("id,started_at,finished_at,status,counts,mode")
        .order("started_at", { ascending: false })
        .limit(1),
      client.from("pr_ingredients").select("id", { count: "exact", head: true }).eq("status", "active"),
      client.from("pr_intake_runs").select("id", { count: "exact", head: true }),
      client.from("pr_price_observations").select("id", { count: "exact", head: true }).eq("needs_review", true),
    ]);
  if (totalsRes.error) throw totalsRes.error;
  if (byAcctRes.error) throw byAcctRes.error;
  if (byVendorRes.error) throw byVendorRes.error;

  // PostgREST returns numeric columns as strings; Number() handles both.
  const t = (totalsRes.data ?? {}) as Record<string, unknown>;
  const n = (k: string) => Number(t[k] ?? 0);
  const totals: Totals = {
    food_items_active: n("food_items_active"),
    food_items_total: n("food_items_active"),
    food_items_with_number: n("food_items_with_number"),
    food_items_waiting: n("food_items_waiting"),
    food_items_waiting_usd: n("food_items_waiting_usd"),
    food_dollars_total: n("food_dollars_total"),
    food_dollars_linked: n("food_dollars_linked"),
    packs_clean: n("packs_clean"),
    catch_weight_items: n("catch_weight_items"),
    no_number_items: n("no_number_items"),
    no_number_dollars: n("no_number_dollars"),
    needs_review_lines: needsReviewLinesRes.count ?? 0,
    twins_count: n("twins_count"),
  };

  const bySite: Array<[string, { food: number; linked: number }]> = (
    (byAcctRes.data ?? []) as Array<{ account_key: string; food: unknown; linked: unknown }>
  ).map((r) => [r.account_key, { food: Number(r.food ?? 0), linked: Number(r.linked ?? 0) }]);

  const topVendors: Array<[string, { food: number; linked: number }]> = (
    (byVendorRes.data ?? []) as Array<{ vendor_name: string; food: unknown; linked: unknown }>
  ).map((r) => [r.vendor_name, { food: Number(r.food ?? 0), linked: Number(r.linked ?? 0) }]);

  return {
    totals,
    lastRun: ((runsRes.data ?? [])[0] ?? null) as IntakeRun | null,
    ingredientsNamed: ingredientsRes.count ?? 0,
    intakeRunsTotal: runCountRes.count ?? 0,
    bySite,
    topVendors,
  };
}

export async function Overview() {
  const { totals, lastRun, ingredientsNamed, intakeRunsTotal, bySite, topVendors } = await loadTotals();

  const lastRunLabel = lastRun
    ? `${new Date(lastRun.started_at).toLocaleString()} - ${lastRun.status}`
    : "No intake run yet";

  return (
    <div className="kf-ing">
      <header className="kf-ing__header">
        <span className="kf-eyebrow">Culinary office</span>
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
        <p className="kf-coverage__note">Linking starts in step 5. The dark bar fills as items are named.</p>
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
        <p className="kf-coverage__note">Linking starts in step 5.</p>
        {topVendors.length === 0 ? (
          <div className="kf-state">
            <div className="kf-state__title">No vendors with food dollars yet</div>
            <div className="kf-state__body">Run intake and this list will populate.</div>
          </div>
        ) : (
          <ul className="kf-meters">
            {topVendors.map(([name, { food, linked }]) => (
              <li key={name}>
                <div className="kf-meter__row">
                  <span className="kf-meter__name">{name}</span>
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
            <div><dt>Packs parsed</dt><dd>{totals.packs_clean.toLocaleString()}</dd></div>
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
