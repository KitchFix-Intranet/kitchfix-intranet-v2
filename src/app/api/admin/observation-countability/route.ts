import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { COUNTABLE_OBSERVATIONS_VIEW } from "@/lib/ingredients/countability";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// N0b: observation-countability report + per-item counter recompute.
//
// What N0b removes from the N0 build:
//
//   - The excluded_reason UPDATE. Under N0b the view
//     pr_countable_observations (migrations 0012 / 0013) excludes
//     superseded and deleted rows by structure, so no write is
//     needed on pr_price_observations itself. Deleting the UPDATE
//     removes the N0a clobber risk (120 superseded rows that carry
//     `not_food` or `needs_review` are preserved) and the latent
//     trap (when Kevin resolves a review and excluded_reason goes
//     null, the view still excludes the row because it is still
//     structurally superseded).
//
// What N0b keeps from N0:
//
//   - Classification of every observation (reads pr_price_observations
//     directly, including rows the view excludes) so the orphan,
//     abandoned-correction and already-excluded buckets stay visible
//     to Kevin.
//   - Per-item diff (stored usd vs recomputed usd from the view).
//   - top50 by |delta|, diffMismatch sanity check, acceptanceTarget,
//     reportOnly.
//
// What N0b still does live:
//
//   - Per-affected-item counter recompute from pr_countable_observations.
//     Emits one pr_events('countability_recount') per changed item
//     with before / after. This is the write that actually delivers
//     the $63,171.17 move.
//
// dryRun defaults TRUE; opt-in to writing requires explicit
// dryRun=false in body or ?dryRun=false on query.
//
// Measured target 2026-11-05: 591 observations / 503 items /
// $63,171.17 of double-count removed. Full-catalog aggregate 1.27 s
// against the de-correlated view in 0013.

type Submission = {
  id: string;
  invoice_number: string;
  status: string | null;
};

type Observation = {
  id: string;
  vendor_item_id: string;
  line_id: string;
  extended_price: number | null;
  invoice_date: string | null;
  account_key: string | null;
  needs_review: boolean | null;
  excluded_reason: string | null;
};

type SubmissionClass =
  | "live"
  | "superseded"
  | "lone_corrected"
  | "deleted";

type ObservationClass =
  | SubmissionClass
  | "orphan_no_line"
  | "orphan_no_submission";

type ClassTotal = { observations: number; usd: number };

type PerItemDiff = {
  id: string;
  name: string;
  vendor_id: string;
  old_usd: number;
  new_usd: number;
  delta_usd: number;
  old_lines: number;
  new_lines: number;
  delta_lines: number;
};

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const dryRunQ = req.nextUrl.searchParams.get("dryRun");
  const dryRun =
    body.dryRun === false
      ? false
      : !(dryRunQ === "false" || dryRunQ === "0");

  const client = serviceClient();

  // --- 1. Load invoice_submissions and classify each.
  const submissionsAll: Submission[] = [];
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await client
        .from("invoice_submissions")
        .select("id,invoice_number,status")
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const rows = (data ?? []) as Submission[];
      submissionsAll.push(...rows);
      if (rows.length < page) break;
      from += page;
    }
  }

  const submissionClass = new Map<string, SubmissionClass>();
  {
    const byInvoiceNumber = new Map<string, Submission[]>();
    for (const s of submissionsAll) {
      // N0b: the view uses btrim(invoice_number) because 4 of 2,722
      // invoice_number values carry surrounding whitespace. Mirror
      // that here so client-side classification agrees with the
      // view's exclusion.
      const key = s.invoice_number?.trim();
      if (!key) continue;
      const list = byInvoiceNumber.get(key) ?? [];
      list.push(s);
      byInvoiceNumber.set(key, list);
    }
    for (const list of byInvoiceNumber.values()) {
      const hasLive = list.some(
        (s) => s.status !== "corrected" && s.status !== "deleted"
      );
      for (const s of list) {
        if (s.status === "deleted") submissionClass.set(s.id, "deleted");
        else if (s.status === "corrected")
          submissionClass.set(s.id, hasLive ? "superseded" : "lone_corrected");
        else submissionClass.set(s.id, "live");
      }
    }
  }

  const submissionCounts: Record<SubmissionClass, number> = {
    live: 0,
    superseded: 0,
    lone_corrected: 0,
    deleted: 0,
  };
  for (const cls of submissionClass.values()) submissionCounts[cls] += 1;

  // --- 2. Load ALL observations (not just countable). We classify
  // every row for the report - including rows the view excludes -
  // so Kevin can see orphan, abandoned-correction and
  // already-excluded buckets alongside the "actually moving"
  // superseded set.
  const observations: Observation[] = [];
  {
    let from = 0;
    const page = 1000;
    for (;;) {
      const { data, error } = await client
        .from("pr_price_observations")
        .select(
          "id,vendor_item_id,line_id,extended_price,invoice_date,account_key,needs_review,excluded_reason"
        )
        .order("id", { ascending: true })
        .range(from, from + page - 1);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const rows = (data ?? []) as Observation[];
      observations.push(...rows);
      if (rows.length < page) break;
      from += page;
    }
  }

  // --- 3. Resolve each observation's line_id to its invoice_uuid.
  const lineIdToInvoiceUuid = new Map<string, string | null>();
  {
    const lineIds = Array.from(new Set(observations.map((o) => o.line_id)));
    for (let i = 0; i < lineIds.length; i += 500) {
      const slice = lineIds.slice(i, i + 500);
      const { data, error } = await client
        .from("ai_line_items")
        .select("id,invoice_uuid")
        .in("id", slice);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      for (const r of (data ?? []) as Array<{
        id: string;
        invoice_uuid: string | null;
      }>) {
        lineIdToInvoiceUuid.set(r.id, r.invoice_uuid);
      }
    }
  }

  // --- 4. Classify each observation; accumulate class totals.
  const classified: Array<{ obs: Observation; cls: ObservationClass }> = [];
  const classTotals: Record<ObservationClass, ClassTotal> = {
    live: { observations: 0, usd: 0 },
    superseded: { observations: 0, usd: 0 },
    lone_corrected: { observations: 0, usd: 0 },
    deleted: { observations: 0, usd: 0 },
    orphan_no_line: { observations: 0, usd: 0 },
    orphan_no_submission: { observations: 0, usd: 0 },
  };
  for (const o of observations) {
    const ext = Number(o.extended_price ?? 0) || 0;
    let cls: ObservationClass;
    if (!lineIdToInvoiceUuid.has(o.line_id)) {
      cls = "orphan_no_line";
    } else {
      const invUuid = lineIdToInvoiceUuid.get(o.line_id);
      if (invUuid == null) {
        cls = "orphan_no_submission";
      } else {
        const subCls = submissionClass.get(invUuid);
        cls = subCls ?? "orphan_no_submission";
      }
    }
    classTotals[cls].observations += 1;
    classTotals[cls].usd += ext;
    classified.push({ obs: o, cls });
  }

  // --- 5. Identify observations that MOVE under the view. An
  // observation moves when:
  //   - it is currently-countable (excluded_reason IS NULL on the base
  //     table), AND
  //   - its structural class is 'superseded' or 'deleted'
  // These are exactly the rows pr_countable_observations excludes
  // but pr_price_observations-with-excluded_reason-null-filter did
  // not. The acceptance target maps against this set.
  const movingSuperseded = classified.filter(
    (c) => c.cls === "superseded" && c.obs.excluded_reason == null
  );
  const movingDeleted = classified.filter(
    (c) => c.cls === "deleted" && c.obs.excluded_reason == null
  );
  // Same structural class, but already excluded on other grounds -
  // reported for transparency; the view hides them for a different
  // reason (`not_food`/`needs_review`), so nothing moves.
  const alreadyExcludedSuperseded = classified.filter(
    (c) => c.cls === "superseded" && c.obs.excluded_reason != null
  );
  const alreadyExcludedDeleted = classified.filter(
    (c) => c.cls === "deleted" && c.obs.excluded_reason != null
  );

  // --- 6. Build per-item diff. For every item that owns at least
  // one moving observation, compare stored usd / lines against the
  // recomputed values. Dry-run and live diverge only in whether the
  // recompute lands in the DB.
  const excludePerItem = new Map<
    string,
    { usd: number; lines: number }
  >();
  for (const c of [...movingSuperseded, ...movingDeleted]) {
    const ext = Number(c.obs.extended_price ?? 0) || 0;
    const cur = excludePerItem.get(c.obs.vendor_item_id) ?? {
      usd: 0,
      lines: 0,
    };
    cur.usd += ext;
    cur.lines += 1;
    excludePerItem.set(c.obs.vendor_item_id, cur);
  }

  const affectedItemIds = Array.from(excludePerItem.keys());
  const perItemDiff: PerItemDiff[] = [];
  const diffMismatch: Array<{ id: string; storedUsd: number; sumUsd: number }> = [];

  if (affectedItemIds.length > 0) {
    // Sum of currently-countable observations per affected item.
    // Used for the diffMismatch sanity check: if stored usd equals
    // this sum, the derived new_usd (= stored - excluded) matches
    // what the view recompute would produce. Divergence flags an
    // arithmetic drift we did not introduce.
    const sumPerItem = new Map<
      string,
      { usd: number; lines: number }
    >();
    for (const c of classified) {
      if (!excludePerItem.has(c.obs.vendor_item_id)) continue;
      if (c.obs.excluded_reason != null) continue;
      const ext = Number(c.obs.extended_price ?? 0) || 0;
      const cur = sumPerItem.get(c.obs.vendor_item_id) ?? {
        usd: 0,
        lines: 0,
      };
      cur.usd += ext;
      cur.lines += 1;
      sumPerItem.set(c.obs.vendor_item_id, cur);
    }

    for (let i = 0; i < affectedItemIds.length; i += 500) {
      const slice = affectedItemIds.slice(i, i + 500);
      const { data, error } = await client
        .from("pr_vendor_items")
        .select("id,name,vendor_id,usd,lines")
        .in("id", slice);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      for (const r of (data ?? []) as Array<{
        id: string;
        name: string;
        vendor_id: string;
        usd: number | string;
        lines: number;
      }>) {
        const exclude = excludePerItem.get(r.id)!;
        const sumHere = sumPerItem.get(r.id) ?? { usd: 0, lines: 0 };
        const storedUsd = Number(r.usd) || 0;
        const newUsd = Number(
          (Math.max(0, storedUsd - exclude.usd)).toFixed(2)
        );
        const oldLines = r.lines ?? 0;
        const newLines = Math.max(0, oldLines - exclude.lines);
        perItemDiff.push({
          id: r.id,
          name: r.name,
          vendor_id: r.vendor_id,
          old_usd: Number(storedUsd.toFixed(2)),
          new_usd: newUsd,
          delta_usd: Number((newUsd - storedUsd).toFixed(2)),
          old_lines: oldLines,
          new_lines: newLines,
          delta_lines: newLines - oldLines,
        });
        if (Math.abs(storedUsd - sumHere.usd) > 0.01) {
          diffMismatch.push({
            id: r.id,
            storedUsd: Number(storedUsd.toFixed(2)),
            sumUsd: Number(sumHere.usd.toFixed(2)),
          });
        }
      }
    }
  }

  perItemDiff.sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd));
  const top50 = perItemDiff.slice(0, 50);

  // --- 7. Totals for the response.
  const summary = {
    toMove: {
      superseded: {
        observations: movingSuperseded.length,
        usd: Number(
          movingSuperseded
            .reduce((a, c) => a + (Number(c.obs.extended_price ?? 0) || 0), 0)
            .toFixed(2)
        ),
      },
      deleted: {
        observations: movingDeleted.length,
        usd: Number(
          movingDeleted
            .reduce((a, c) => a + (Number(c.obs.extended_price ?? 0) || 0), 0)
            .toFixed(2)
        ),
      },
      itemsAffected: affectedItemIds.length,
      totalUsd: Number(
        [...movingSuperseded, ...movingDeleted]
          .reduce((a, c) => a + (Number(c.obs.extended_price ?? 0) || 0), 0)
          .toFixed(2)
      ),
    },
    alreadyExcluded: {
      superseded: {
        observations: alreadyExcludedSuperseded.length,
        byReason: alreadyExcludedSuperseded.reduce(
          (acc, c) => {
            const k = c.obs.excluded_reason ?? "(null)";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),
      },
      deleted: {
        observations: alreadyExcludedDeleted.length,
        byReason: alreadyExcludedDeleted.reduce(
          (acc, c) => {
            const k = c.obs.excluded_reason ?? "(null)";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),
      },
    },
    reportOnly: {
      orphans: {
        no_line: classTotals.orphan_no_line,
        no_submission: classTotals.orphan_no_submission,
        total: {
          observations:
            classTotals.orphan_no_line.observations +
            classTotals.orphan_no_submission.observations,
          usd: Number(
            (
              classTotals.orphan_no_line.usd +
              classTotals.orphan_no_submission.usd
            ).toFixed(2)
          ),
        },
        description:
          "Observation's line_id resolves to no submission. The view still COUNTS these - they may be real spend with a broken link. Report-only; Kevin rules.",
      },
      lone_corrected: {
        observations: classTotals.lone_corrected.observations,
        usd: Number(classTotals.lone_corrected.usd.toFixed(2)),
        description:
          "'corrected' submission is the only copy of its invoice. The correction was started and never completed; the view still COUNTS these. Report-only; Kevin rules.",
      },
    },
    acceptanceTarget: {
      superseded: { observations: 591, items: 503, usd: 63171.17 },
      deleted: { observations: 0, items: 0, usd: 0 },
      note: "2026-11-05 live. The view excludes the 591 structurally-superseded rows that were previously counted; already-excluded rows count toward alreadyExcluded, not toMove.",
    },
  };

  // --- 8. Live: per-affected-item counter recompute FROM THE VIEW.
  // The route no longer writes excluded_reason. The only live write
  // is the pr_vendor_items counter update, emitted with a
  // pr_events('countability_recount') per changed item.
  const writes = {
    itemsRecomputed: 0,
    itemsUnchanged: 0,
    recomputeFailures: [] as Array<{ itemId: string; error: string }>,
  };

  if (!dryRun) {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);

    for (const itemId of affectedItemIds) {
      // Snapshot pre-counters for the pr_events before payload.
      const { data: beforeRow, error: beforeErr } = await client
        .from("pr_vendor_items")
        .select(
          "lines,lines_12m,usd,usd_12m,accounts,first_seen,last_seen,needs_review_lines"
        )
        .eq("id", itemId)
        .maybeSingle();
      if (beforeErr) {
        writes.recomputeFailures.push({
          itemId,
          error: `before read: ${beforeErr.message}`,
        });
        continue;
      }

      // Recount from the view. Same shape as the merge executor's
      // recount in rescan-apply:executeMergePlan; the view now owns
      // the exclusion rule so neither callsite has to encode it.
      let lines = 0;
      let lines12 = 0;
      let usd = 0;
      let usd12 = 0;
      let first: string | null = null;
      let last: string | null = null;
      const accountSet = new Set<string>();
      let needsReview = 0;
      let from = 0;
      const page = 1000;
      let readOk = true;
      for (;;) {
        const { data, error } = await client
          .from(COUNTABLE_OBSERVATIONS_VIEW)
          .select("extended_price,invoice_date,account_key,needs_review")
          .eq("vendor_item_id", itemId)
          .range(from, from + page - 1);
        if (error) {
          writes.recomputeFailures.push({
            itemId,
            error: `obs read: ${error.message}`,
          });
          readOk = false;
          break;
        }
        const rows = (data ?? []) as Array<{
          extended_price: number | null;
          invoice_date: string | null;
          account_key: string | null;
          needs_review: boolean | null;
        }>;
        for (const r of rows) {
          lines += 1;
          if (r.extended_price != null) {
            const n = Number(r.extended_price);
            if (Number.isFinite(n)) usd += n;
          }
          if (r.invoice_date) {
            if (!first || r.invoice_date < first) first = r.invoice_date;
            if (!last || r.invoice_date > last) last = r.invoice_date;
            if (r.invoice_date >= cutoff) {
              lines12 += 1;
              if (r.extended_price != null) {
                const n = Number(r.extended_price);
                if (Number.isFinite(n)) usd12 += n;
              }
            }
          }
          if (r.account_key) accountSet.add(r.account_key);
          if (r.needs_review === true) needsReview += 1;
        }
        if (rows.length < page) break;
        from += page;
      }
      if (!readOk) continue;

      const after = {
        lines,
        lines_12m: lines12,
        usd: Number(usd.toFixed(2)),
        usd_12m: Number(usd12.toFixed(2)),
        accounts: Array.from(accountSet),
        first_seen: first,
        last_seen: last,
        needs_review_lines: needsReview,
      };

      // Skip no-op writes - a row whose stored counters already
      // match the view-derived counters doesn't need a write or an
      // event. Only write when something actually changes.
      const beforeSnap = (beforeRow ?? {}) as Record<string, unknown>;
      const unchanged =
        Number(beforeSnap.lines ?? 0) === after.lines &&
        Number(beforeSnap.lines_12m ?? 0) === after.lines_12m &&
        Number(beforeSnap.usd ?? 0).toFixed(2) === after.usd.toFixed(2) &&
        Number(beforeSnap.usd_12m ?? 0).toFixed(2) === after.usd_12m.toFixed(2) &&
        Number(beforeSnap.needs_review_lines ?? 0) === after.needs_review_lines;
      if (unchanged) {
        writes.itemsUnchanged += 1;
        continue;
      }

      const { error: upErr } = await client
        .from("pr_vendor_items")
        .update(after)
        .eq("id", itemId);
      if (upErr) {
        writes.recomputeFailures.push({
          itemId,
          error: `update: ${upErr.message}`,
        });
        continue;
      }
      writes.itemsRecomputed += 1;

      await client.from("pr_events").insert({
        entity_type: "vendor_item",
        entity_id: itemId,
        kind: "countability_recount",
        before: beforeRow,
        after,
        actor: "observation-countability",
        note:
          "N0b: recomputed from pr_countable_observations view (0012/0013)",
      });
    }
  }

  return NextResponse.json({
    dryRun,
    definition: {
      source_view: COUNTABLE_OBSERVATIONS_VIEW,
      module: "src/lib/ingredients/countability.ts",
      migrations: ["0012", "0013"],
      rule:
        "The view pr_countable_observations excludes rows where (a) excluded_reason IS NOT NULL (Kevin's curation), (b) submission.status = 'deleted', or (c) submission.status = 'corrected' AND a non-corrected, non-deleted sibling exists for the same invoice_number. Orphans and abandoned corrections stay countable pending a ruling.",
      writes: dryRun
        ? "none (dryRun)"
        : "pr_vendor_items counters + pr_events; excluded_reason is NEVER written by this route",
    },
    submissions: {
      total: submissionClass.size,
      distinctInvoiceNumbers:
        new Set(submissionsAll.map((s) => s.invoice_number?.trim() ?? "")).size,
      classes: submissionCounts,
    },
    observations: {
      loaded: observations.length,
      byClass: classTotals,
    },
    summary,
    perItemDiff,
    top50,
    diffMismatch,
    writes: dryRun ? null : writes,
  });
}
