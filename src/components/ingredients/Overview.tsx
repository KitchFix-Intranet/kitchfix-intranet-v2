// Ingredients landing. Render V4 shape: identity band carrying the status
// headline + the Open-vendor-items CTA, five tiles with hydration-safe
// count-up, two coverage meter cards side by side, a Data health + Last
// intake pair, phone layout with the manifesto behind a <details>.
//
// All vendor-item aggregation goes through the pr_v_overview_* views so
// no PostgREST truncation ever hits this page.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { serviceClient } from "@/lib/supabase/service";
import { fmtCount, fmtDate, fmtDuration, fmtStatus, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import { IdentBand } from "@/components/ui/IdentBand";
import { CountUp } from "@/components/ui/CountUp";
import { Tabs } from "./Tabs";
import { CoverageMeters } from "./CoverageMeters";
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

type MeterRow = { name: string; food: number; linked: number };

async function loadOverview(): Promise<{
  totals: Totals;
  lastRun: IntakeRun | null;
  ingredientsNamed: number;
  bySite: MeterRow[];
  topVendors: MeterRow[];
}> {
  const client = serviceClient();
  const [totalsRes, byAcctRes, byVendorRes, runsRes, ingredientsRes, needsReviewLinesRes] =
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
      client.from("pr_price_observations").select("id", { count: "exact", head: true }).eq("needs_review", true),
    ]);
  if (totalsRes.error) throw totalsRes.error;
  if (byAcctRes.error) throw byAcctRes.error;
  if (byVendorRes.error) throw byVendorRes.error;

  const t = (totalsRes.data ?? {}) as Record<string, unknown>;
  const n = (k: string) => Number(t[k] ?? 0);
  const totals: Totals = {
    food_items_active: n("food_items_active"),
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

  const bySite: MeterRow[] = (byAcctRes.data ?? []).map((r) => {
    const row = r as { account_key: string; food: unknown; linked: unknown };
    return { name: row.account_key, food: Number(row.food ?? 0), linked: Number(row.linked ?? 0) };
  });
  const topVendors: MeterRow[] = (byVendorRes.data ?? []).map((r) => {
    const row = r as { vendor_name: string; food: unknown; linked: unknown };
    return { name: row.vendor_name, food: Number(row.food ?? 0), linked: Number(row.linked ?? 0) };
  });

  return {
    totals,
    lastRun: ((runsRes.data ?? [])[0] ?? null) as IntakeRun | null,
    ingredientsNamed: ingredientsRes.count ?? 0,
    bySite,
    topVendors,
  };
}

function pct(num: number, den: number): string {
  if (den <= 0) return "0%";
  return `${Math.round((num / den) * 100)}%`;
}

function identityOf(n: number): string { return fmtCount(n); }

export async function Overview() {
  let overview: Awaited<ReturnType<typeof loadOverview>>;
  let bandStatus: "ok" | "failed" | "running" = "ok";
  try {
    overview = await loadOverview();
  } catch {
    return (
      <div className="kf-ing">
        <Tabs active="overview" />
        <IdentBand
          eyebrow="Where we stand"
          title="Status unavailable"
          kick="Couldn't read intake status."
          status="failed"
          pageName="Ingredients"
        />
      </div>
    );
  }
  const { totals, lastRun, ingredientsNamed, bySite, topVendors } = overview;
  if (lastRun?.status === "running") bandStatus = "running";
  else if (lastRun?.status === "failed") bandStatus = "failed";

  const unlinkedUsd = totals.food_items_waiting_usd;
  const bandHeadline = `${fmtUsd(unlinkedUsd)} of food waiting to be named`;
  const lastIntakeFactNote = lastRun
    ? `${fmtStatus(lastRun.status)} - ${fmtDate(lastRun.started_at, "time")}`
    : "No intake run yet";
  const linesReadFromRun = Number(
    (lastRun?.counts as Record<string, unknown> | null)?.lines_read ?? 0
  );

  return (
    <div className="kf-ing">
      <IdentBand
        eyebrow="Where we stand"
        title={bandHeadline}
        kick="What we buy, in our words: every line, named once."
        kickInfo={
          <>
            <p style={{ margin: 0 }}>
              Invoice lines become vendor items; vendor items link to one
              ingredient; the price a recipe sees is the company price with a
              date on it.
            </p>
            <p style={{ margin: "var(--sp-sp-2) 0 0" }}>
              Nothing enters without a human saying so.
            </p>
          </>
        }
        facts={[
          { label: "Last intake", value: lastRun ? fmtStatus(lastRun.status) : "-", note: lastRun ? fmtDate(lastRun.started_at, "time") : "No run yet" },
          { label: "Lines read", value: identityOf(linesReadFromRun) },
        ]}
        cta={{ label: "Open vendor items", href: "/stockpot/ingredients/vendor-items" }}
        status={bandStatus}
        runningStartedAt={bandStatus === "running" ? lastRun?.started_at ?? null : null}
        pageName="Ingredients"
      />

      <section className="kf-only-phone kf-ing__phone-action" aria-label="Intake">
        <article className="kf-fact">
          <span className="kf-fact__label">Last intake</span>
          <span className="kf-fact__value">{lastRun ? fmtStatus(lastRun.status) : "-"}</span>
          <span className="kf-fact__note">{lastIntakeFactNote}</span>
        </article>
        <Link href="/stockpot/ingredients/vendor-items" className="kf-btn kf-btn--soft kf-btn--sm">
          <span>Vendor items</span>
          <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </section>

      <Tabs active="overview" />

      <section className="kf-tiles kf-reveal" aria-label="Headline numbers" style={{ ["--i" as never]: 2 }}>
        <article className="kf-tile kf-tile--lead">
          <span className="kf-tile__label">Food dollars linked</span>
          <span className="kf-tile__value">
            {pct(totals.food_dollars_linked, totals.food_dollars_total)}
          </span>
          <span className="kf-tile__sub">
            {fmtUsd(totals.food_dollars_linked)} of {fmtUsd(totals.food_dollars_total)}, 12 months
          </span>
        </article>
        <article className="kf-tile">
          <span className="kf-tile__label">Active food items</span>
          <span className="kf-tile__value">
            <CountUp value={totals.food_items_active} format={fmtCount} />
          </span>
          <span className="kf-tile__sub">
            {fmtCount(totals.food_items_with_number)} carry an item number
          </span>
        </article>
        <article className="kf-tile">
          <span className="kf-tile__label">Waiting for you</span>
          <span className="kf-tile__value">
            <CountUp value={totals.food_items_waiting} format={fmtCount} />
          </span>
          <span className="kf-tile__sub">{fmtUsd(totals.food_items_waiting_usd)} unlinked (12m)</span>
        </article>
        <article className="kf-tile">
          <span className="kf-tile__label">Twins to resolve</span>
          <span className="kf-tile__value">
            <CountUp value={totals.twins_count} format={fmtCount} />
          </span>
          <span className="kf-tile__sub">Same item, two numbers</span>
        </article>
        <article className="kf-tile kf-tile--named">
          <span className="kf-tile__label">Ingredients named</span>
          <span className="kf-tile__value">
            <CountUp value={ingredientsNamed} format={fmtCount} />
          </span>
          <span className="kf-tile__sub">Starts with the review queue</span>
        </article>
      </section>

      <details className="kf-only-phone kf-ing__manifesto">
        <summary>What is this?</summary>
        <p>
          Invoice lines become vendor items; vendor items link to one
          ingredient; the price a recipe sees is the company price with a
          date on it. Nothing enters without a human saying so.
        </p>
      </details>

      <section className="kf-two kf-reveal" style={{ ["--i" as never]: 3 }} aria-label="Coverage">
        <article className="kf-card kf-coverage-card">
          <header className="kf-section-head">
            <span className="kf-eyebrow kf-eyebrow--plain">Coverage by site</span>
            <h3>How food dollars split</h3>
            <ul className="kf-coverage__legend" aria-label="Legend">
              <li><span className="kf-swatch kf-swatch--share" aria-hidden /> Share of this list</li>
              <li><span className="kf-swatch kf-swatch--linked" aria-hidden /> Linked</li>
            </ul>
          </header>
          <CoverageMeters rows={bySite} />
        </article>

        <article className="kf-card kf-coverage-card">
          <header className="kf-section-head">
            <span className="kf-eyebrow kf-eyebrow--plain">Coverage by vendor</span>
            <h3>Top 10 by 12-month dollars</h3>
            <ul className="kf-coverage__legend" aria-label="Legend">
              <li><span className="kf-swatch kf-swatch--share" aria-hidden /> Share of this list</li>
              <li><span className="kf-swatch kf-swatch--linked" aria-hidden /> Linked</li>
            </ul>
          </header>
          <CoverageMeters rows={topVendors} />
        </article>
      </section>

      <section className="kf-health kf-reveal" style={{ ["--i" as never]: 4 }} aria-label="Health + last intake">
        <article className="kf-card">
          <header><span className="kf-eyebrow kf-eyebrow--plain">Data health</span><h3>What the lines look like</h3></header>
          <dl className="kf-kv">
            <div>
              <dt>{fmtCount(totals.no_number_items)} items with no number</dt>
              <dd>{fmtUsd(totals.no_number_dollars)}</dd>
            </div>
            <div>
              <dt>{fmtCount(totals.needs_review_lines)} flagged on the invoice</dt>
              <dd>-</dd>
            </div>
            <div>
              <dt>{fmtCount(totals.catch_weight_items)} catch-weight items</dt>
              <dd>-</dd>
            </div>
            <div>
              <dt>{fmtCount(totals.twins_count)} twins</dt>
              <dd>-</dd>
            </div>
            <div className="is-missing">
              <dt>Packs parsed</dt>
              <dd>Not read yet</dd>
            </div>
          </dl>
          <footer className="kf-card__foot kf-card__foot--split">
            <span>Counts refresh with every intake</span>
            <Link href="/stockpot/ingredients/vendor-items" className="kf-btn kf-btn--ghost kf-btn--sm">
              <span>Open vendor items</span>
              <ArrowRight size={14} strokeWidth={1.5} />
            </Link>
          </footer>
        </article>

        <article className="kf-card">
          <header>
            <span className="kf-eyebrow kf-eyebrow--plain">Last intake</span>
            <h3>{lastRun ? fmtDate(lastRun.started_at, "time") : "No intake run yet"}</h3>
          </header>
          {lastRun ? (
            <dl className="kf-kv">
              <div>
                <dt>Result</dt>
                <dd>
                  <span
                    className={`kf-pill ${lastRun.status === "failed" ? "kf-pill--block" : "kf-pill--live"}`}
                  >
                    {fmtStatus(lastRun.status)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{fmtDuration(lastRun.started_at, lastRun.finished_at)}</dd>
              </div>
              <div>
                <dt>Lines read</dt>
                <dd>{fmtCount(Number((lastRun.counts as Record<string, unknown> | null)?.lines_read ?? 0))}</dd>
              </div>
              <div>
                <dt>Set aside as not food</dt>
                <dd>{fmtCount(Number((lastRun.counts as Record<string, unknown> | null)?.lines_excluded_not_food ?? 0))}</dd>
              </div>
              <div>
                <dt>Set aside for review</dt>
                <dd>{fmtCount(Number((lastRun.counts as Record<string, unknown> | null)?.lines_excluded_needs_review ?? 0))}</dd>
              </div>
            </dl>
          ) : (
            <p className="kf-card__muted">Nothing has been read yet. Run intake from the top bar.</p>
          )}
          <footer className="kf-card__foot">
            Runs nightly; run it now from the top bar after a vendor upload.
          </footer>
        </article>
      </section>
    </div>
  );
}
