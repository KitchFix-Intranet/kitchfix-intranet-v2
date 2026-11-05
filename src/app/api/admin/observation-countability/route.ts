import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { applyCountableFilter } from "@/lib/ingredients/countability";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// N0: observation-countability report + backfill.
//
// Why: pr_vendor_items price and spend counters (lines, usd,
// lines_12m, usd_12m) recompute from pr_price_observations WITHOUT
// excluding observations whose line belongs to a superseded invoice
// submission. An invoice number can carry several invoice_submissions
// rows; status='corrected' marks the superseded ones. When an
// invoice is re-submitted, both copies' lines keep their
// observations, and both get counted. The same physical purchase is
// counted twice.
//
// Measured 2026-11-05 live, after N0a reconciled against actual
// excluded_reason state: 591 countable superseded observations
// across 503 catalog items, overstating spend by $63,171.17. For
// comparison, the entire re-scan apply moved net spend by $315.
// A separate 120 superseded observations already carry a non-null
// excluded_reason (`not_food` or `needs_review` - Kevin's own
// curation) and are not touched by this route.
//
// What this route does:
//
//   1. Classifies every pr_price_observations row where
//      excluded_reason IS NULL (currently countable) by walking its
//      line_id -> ai_line_items.invoice_uuid -> invoice_submissions:
//        - 'live'              status is neither 'corrected' nor 'deleted'
//        - 'superseded'        status='corrected' AND the same
//                              invoice_number has another LIVE copy
//        - 'lone_corrected'    status='corrected' AND is the only copy
//        - 'deleted'           status='deleted'
//        - 'orphan_no_line'    line_id resolves to no ai_line_items row
//        - 'orphan_no_submission'
//                              ai_line_items.invoice_uuid is null or
//                              points to no invoice_submissions row
//
//   2. Dry-run: reports per-item diff (old vs recomputed usd/lines),
//      top 50 by |delta|, totals per class. Writes nothing.
//
//   3. Live: sets excluded_reason on the 'superseded' observations
//      ('superseded_submission') and 'deleted' observations
//      ('deleted_submission'), then recomputes the counters on every
//      affected pr_vendor_items row from the now-filtered
//      observations, and emits one pr_events('countability_recount')
//      per item with the before/after counters.
//
// What this route does NOT do:
//
//   - Exclude orphans. 260 observations / $30,947. Report-only until
//     Kevin rules on them. They may be real spend with a broken link.
//   - Exclude 'lone_corrected' observations. 335 observations /
//     $25,870. A 'corrected' submission that is the only copy of
//     its invoice is NOT superseded; the correction was started and
//     never completed. Report-only; treatment unchanged.
//   - Write a migration. All exclusion state lives on the existing
//     pr_price_observations.excluded_reason column.
//   - Deploy, run itself, or run any other route. Kevin runs this
//     one; dry-run first, read the diff, then authorise live.
//
// dryRun defaults TRUE, like rescan-apply. Opt-in to writing
// requires explicit dryRun=false in body or ?dryRun=false on query.

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
  // N0a: carry excluded_reason so classification can split 'already
  // excluded' from 'would exclude now'. The UPDATE at step 8 writes
  // ONLY the latter; the former stays untouched so Kevin's `not_food`
  // and `needs_review` curation on superseded rows is preserved.
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
  //
  // Submission class is scoped per invoice_number: a 'corrected' row
  // is 'superseded' iff another row at the same invoice_number has
  // status that is neither 'corrected' nor 'deleted'. Otherwise it is
  // 'lone_corrected' and still counts.
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
      if (!s.invoice_number) continue;
      const list = byInvoiceNumber.get(s.invoice_number) ?? [];
      list.push(s);
      byInvoiceNumber.set(s.invoice_number, list);
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

  // --- 2. Load ALL observations (not just currently-countable).
  //
  // N0a: a `superseded` row that currently holds `not_food` or
  // `needs_review` is Kevin's own curation decision and must not be
  // overwritten. To distinguish "would become superseded now" from
  // "already excluded on other grounds, superseded as a label only",
  // we classify every row and gate the UPDATE on the current reason
  // being NULL. Paged so > 1000 rows are not silently truncated.
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
  //
  // Lookup against ai_line_items. invoice_uuid may be null (orphan)
  // or point to a submission not in our submissionClass map (also
  // orphan). Service role bypasses RLS.
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

  // --- 5. Identify observations to exclude.
  //
  // N0a: split each candidate class into "countable now" (the UPDATE
  // target) and "already excluded" (skipped - the current reason is a
  // curation decision we do NOT overwrite). The expected acceptance
  // target is 591 superseded obs / 503 items / $63,171.17 - revised
  // down from an earlier 711 / 583 / $73,711 estimate that failed to
  // account for the 120 already-excluded superseded rows. The
  // `deleted` bucket is a no-op in practice: all 5 deleted
  // observations on 2026-11-05 already carried a reason, so this
  // writes zero dollars from deleted. The rule stays because it is
  // right; expect no movement.
  const toExcludeSuperseded = classified.filter(
    (c) => c.cls === "superseded" && c.obs.excluded_reason == null
  );
  const skippedSupersededAlreadyExcluded = classified.filter(
    (c) => c.cls === "superseded" && c.obs.excluded_reason != null
  );
  const toExcludeDeleted = classified.filter(
    (c) => c.cls === "deleted" && c.obs.excluded_reason == null
  );
  const skippedDeletedAlreadyExcluded = classified.filter(
    (c) => c.cls === "deleted" && c.obs.excluded_reason != null
  );
  const toExcludeAll = [...toExcludeSuperseded, ...toExcludeDeleted];

  // --- 6. Build per-item diff. For each affected pr_vendor_items,
  // current usd/lines against (current minus the excluded contribution).
  //
  // Note: we only compute "what the counter would be after excluding
  // these observations"; this assumes the current counter equals the
  // sum of countable observations for the item (excluded_reason IS
  // NULL), which Kevin confirmed holds to the cent on his 12-item
  // sample of 710 items. If any item's current counter already
  // diverges from that sum, the diff flags it in `diffMismatch` below.
  const excludePerItem = new Map<
    string,
    { usd: number; lines: number }
  >();
  for (const c of toExcludeAll) {
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
    // Sum of ALL countable observations per affected item for the
    // diff sanity check. If stored usd equals this sum, "new_usd =
    // stored - excluded" is exact. Divergence surfaces in
    // diffMismatch; we still produce the diff but flag it.
    const sumPerItem = new Map<
      string,
      { usd: number; lines: number }
    >();
    for (const c of classified) {
      if (!excludePerItem.has(c.obs.vendor_item_id)) continue;
      // Only currently-countable observations contribute to stored
      // usd/lines; the already-excluded rows are already out of the
      // counter. Filter so diffMismatch compares apples to apples.
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
        // Sanity: stored usd should equal (sum of countable observations) on
        // every affected item if there's no other arithmetic drift. Flag
        // the mismatches so Kevin sees them even on a dry run.
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
    toExclude: {
      superseded: {
        observations: toExcludeSuperseded.length,
        usd: Number(
          toExcludeSuperseded
            .reduce((a, c) => a + (Number(c.obs.extended_price ?? 0) || 0), 0)
            .toFixed(2)
        ),
      },
      deleted: {
        observations: toExcludeDeleted.length,
        usd: Number(
          toExcludeDeleted
            .reduce((a, c) => a + (Number(c.obs.extended_price ?? 0) || 0), 0)
            .toFixed(2)
        ),
      },
      itemsAffected: affectedItemIds.length,
      totalUsd: Number(
        toExcludeAll
          .reduce((a, c) => a + (Number(c.obs.extended_price ?? 0) || 0), 0)
          .toFixed(2)
      ),
    },
    // N0a: rows the UPDATE skips because they already carry a reason
    // (Kevin's `not_food` or `needs_review`, or the prior
    // `deleted_submission` writes). Expected on 2026-11-05 live:
    // ~120 superseded + ~5 deleted = ~125 total. Excluding them again
    // moves zero dollars; reporting them makes the gap between "total
    // superseded in the DB" and "USD actually moved" obvious.
    alreadyExcluded: {
      superseded: {
        observations: skippedSupersededAlreadyExcluded.length,
        byReason: skippedSupersededAlreadyExcluded.reduce(
          (acc, c) => {
            const k = c.obs.excluded_reason ?? "(null)";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),
      },
      deleted: {
        observations: skippedDeletedAlreadyExcluded.length,
        byReason: skippedDeletedAlreadyExcluded.reduce(
          (acc, c) => {
            const k = c.obs.excluded_reason ?? "(null)";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),
      },
    },
    // N0a: Kevin's revised 2026-11-05 target after the N0 dry run was
    // reconciled against actual excluded_reason state. Previous
    // estimate 711 obs / 583 items / $73,710.79 was wrong because it
    // did not account for the 120 superseded observations already
    // carrying `not_food` or `needs_review`. The correct target is
    // what the UPDATE will actually move.
    acceptanceTarget: {
      superseded: { observations: 591, items: 503, usd: 63171.17 },
      deleted: { observations: 0, items: 0, usd: 0 },
      note: "Rows already carrying a non-null excluded_reason are excluded from these targets; see alreadyExcluded above.",
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
          "Observation's line_id resolves to no submission. May be real spend with a broken link. Report-only; do not exclude without a ruling.",
      },
      lone_corrected: {
        observations: classTotals.lone_corrected.observations,
        usd: Number(classTotals.lone_corrected.usd.toFixed(2)),
        description:
          "'corrected' submission is the only copy of its invoice. The correction was started and never completed; treatment unchanged.",
      },
    },
  };

  // --- 8. Live writes: set excluded_reason, recompute counters,
  // emit pr_events per item. Everything else was a read.
  const writes = {
    observationsExcluded: 0,
    itemsRecomputed: 0,
    recomputeFailures: [] as Array<{ itemId: string; error: string }>,
  };
  if (!dryRun) {
    // (a) Set excluded_reason on observations in bulk, chunked.
    //
    // N0a: the .is("excluded_reason", null) filter is REQUIRED. It
    // guarantees Kevin's `not_food` and `needs_review` curation is
    // never overwritten even if the read-side classification drifted
    // between selection and write - belt-and-braces. The id list
    // already excludes already-reasoned rows from classification; the
    // filter here is a defense-in-depth repeat.
    const chunkUpdate = async (ids: string[], reason: string) => {
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const { error } = await client
          .from("pr_price_observations")
          .update({ excluded_reason: reason })
          .in("id", slice)
          .is("excluded_reason", null);
        if (error) throw new Error(error.message);
      }
    };
    try {
      await chunkUpdate(
        toExcludeSuperseded.map((c) => c.obs.id),
        "superseded_submission"
      );
      writes.observationsExcluded += toExcludeSuperseded.length;
      await chunkUpdate(
        toExcludeDeleted.map((c) => c.obs.id),
        "deleted_submission"
      );
      writes.observationsExcluded += toExcludeDeleted.length;
    } catch (e) {
      return NextResponse.json(
        {
          error:
            e instanceof Error ? e.message : "excluded_reason update failed",
        },
        { status: 500 }
      );
    }

    // (b) Recompute counters on every affected item from observations
    // that now pass the countability filter. Mirror the merge
    // executor's recount shape: lines, lines_12m, usd, usd_12m,
    // accounts, first_seen, last_seen, needs_review_lines. Never sum
    // the two cached counters; always recompute from source.
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
        const q = client
          .from("pr_price_observations")
          .select("extended_price,invoice_date,account_key,needs_review")
          .eq("vendor_item_id", itemId)
          .range(from, from + page - 1);
        const { data, error } = await applyCountableFilter(q);
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

      // Emit pr_events for the counter change. `before` carries the
      // pre-write counters so the audit is self-contained.
      await client.from("pr_events").insert({
        entity_type: "vendor_item",
        entity_id: itemId,
        kind: "countability_recount",
        before: beforeRow,
        after,
        actor: "observation-countability",
        note: "N0: excluded superseded/deleted submission observations",
      });
    }
  }

  return NextResponse.json({
    dryRun,
    definition: {
      predicate_sql: "excluded_reason IS NULL",
      module: "src/lib/ingredients/countability.ts",
      excludeValues: {
        superseded_submission:
          "line belongs to a 'corrected' invoice_submission that has a LIVE replacement (another submission with status neither 'corrected' nor 'deleted') for the same invoice_number",
        deleted_submission: "submission's status is 'deleted'",
      },
      preserved: {
        lone_corrected:
          "a 'corrected' submission that is the only copy of its invoice is NOT superseded - the correction was started and never completed; stays countable",
      },
    },
    submissions: {
      total: submissionClass.size,
      distinctInvoiceNumbers:
        new Set(submissionsAll.map((s) => s.invoice_number)).size,
      classes: submissionCounts,
    },
    observations: {
      currentlyCountable: observations.length,
      byClass: classTotals,
    },
    summary,
    perItemDiff,
    top50,
    diffMismatch,
    writes: dryRun ? null : writes,
  });
}
