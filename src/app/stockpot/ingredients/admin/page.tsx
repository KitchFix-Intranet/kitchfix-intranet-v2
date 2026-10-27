// Owner-only admin surface for one-click Potrack maintenance jobs.
// Currently hosts the pack normalizer backfill (step 5 Phase 1).

import { requireOwnerPage } from "@/lib/gate";
import { Tabs } from "@/components/ingredients/Tabs";
import { PackBackfillButton } from "@/components/ingredients/PackBackfillButton";
import { PackOverrideMigrateButton } from "@/components/ingredients/PackOverrideMigrateButton";
import "@/components/ingredients/ingredients.css";
import "@/components/ingredients/review.css";

export default async function IngredientAdminPage() {
  await requireOwnerPage();

  return (
    <div className="kf-ing">
      <header className="kf-ing__header">
        <span className="kf-eyebrow">Culinary office</span>
        <h2>Admin</h2>
        <p className="kf-ing__kicker">
          One-click maintenance for the ingredient data. Each job is idempotent and respects
          human overrides.
        </p>
      </header>

      <Tabs active="overview" />

      <section className="kf-admin-section" aria-labelledby="pack-backfill-head">
        <header className="kf-admin-section__head">
          <h3 id="pack-backfill-head">Pack normalizer backfill</h3>
          <p>
            Reads each food item&rsquo;s pack text (catalog preferred, invoice fallback), runs the
            shared <code>parsePack</code> util, computes a per-base unit price (<code>$ / lb</code>,
            <code> $ / fl oz</code>, <code>$ / each</code>) where it&rsquo;s confident, and stamps
            <code> pack_qty / pack_size / pack_uom / pack_state / price_estimate</code>. Rows with
            a human <code>pack_override</code> are left untouched. Safe to re-run.
          </p>
        </header>

        <PackBackfillButton />
      </section>

      <section className="kf-admin-section" aria-labelledby="pack-override-migrate-head">
        <header className="kf-admin-section__head">
          <h3 id="pack-override-migrate-head">Migrate text pack overrides to structured</h3>
          <p>
            One-time pass over the pre-Phase-1.8 free-text pack overrides. Converts each via the
            shared <code>parsePack</code> + <code>estimateFromOverride</code> helpers so every row
            ends up with <code>pack_qty / pack_size / pack_uom</code> and a recomputed per-unit.
            Rows the parser can&rsquo;t reduce flip to <code>pack_state=&apos;override&apos;</code> with a
            re-enter note so Kevin spots them in the panel. Idempotent.
          </p>
        </header>

        <PackOverrideMigrateButton />
      </section>
    </div>
  );
}
