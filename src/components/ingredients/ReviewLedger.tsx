// Recent decisions / ledger. Reads the last 25 review-flow pr_events rows
// and renders them with an Undo button on the ones that can be reversed
// (review_confirm with items still link_status='confirmed'). The Undo
// button loops /api/review/undo for every item_id in the event.
//
// Server component. The <UndoLedgerButton /> is the only interactive bit;
// it is "use client" and receives item_ids as a plain string[] prop.

import { serviceClient } from "@/lib/supabase/service";
import { fmtUsdLong, timeAgo, fmtDate } from "@/lib/fmt";
import { UndoLedgerButton } from "./UndoLedgerButton";
import { UndoMergeButton } from "./UndoMergeButton";

type Ingredient = { id: string; name: string; parent: string | null };

type EventRow = {
  id: string;
  kind: string;
  at: string;
  actor: string | null;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function ReviewLedger({ ingredients }: { ingredients: Ingredient[] }) {
  const client = serviceClient();
  const { data, error } = await client
    .from("pr_events")
    .select("id,kind,at,actor,entity_id,before,after")
    .in("kind", [
      "review_confirm",
      "review_undo",
      "review_notfood",
      "review_keep_separate",
      "review_relink",
      "ingredient_created",
      "ingredient_merged",
      "ingredient_merge_undo",
    ])
    .order("at", { ascending: false })
    .limit(25);
  if (error) throw error;
  const events = (data ?? []) as EventRow[];

  if (events.length === 0) {
    return (
      <section className="kf-review__ledger" aria-label="Recent decisions">
        <header className="kf-review__ledger-head">
          <h3>Recent decisions</h3>
          <span>Confirmations, undos and relinks land here.</span>
        </header>
        <p className="kf-review__ledger-empty">
          Nothing yet. Confirm a group above and it will show here with an Undo button.
        </p>
      </section>
    );
  }

  // Which confirms are still eligible to undo? Query the items in all
  // confirm events in one batch - cheaper than N round-trips.
  const confirmItemIds = new Set<string>();
  for (const e of events) {
    if (e.kind !== "review_confirm") continue;
    for (const id of asStringArray(e.after?.item_ids)) confirmItemIds.add(id);
  }
  const stillConfirmed = new Set<string>();
  if (confirmItemIds.size > 0) {
    const ids = Array.from(confirmItemIds);
    const page = 200;
    for (let i = 0; i < ids.length; i += page) {
      const slice = ids.slice(i, i + page);
      const { data: vi } = await client
        .from("pr_vendor_items")
        .select("id,link_status")
        .in("id", slice);
      for (const row of (vi ?? []) as { id: string; link_status: string }[]) {
        if (row.link_status === "confirmed") stillConfirmed.add(row.id);
      }
    }
  }

  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

  return (
    <section className="kf-review__ledger" aria-label="Recent decisions">
      <header className="kf-review__ledger-head">
        <h3>Recent decisions</h3>
        <span>Last {events.length} actions. Undo reverses a confirm.</span>
      </header>
      <ul className="kf-review__ledger-list">
        {events.map((e) => (
          <li key={e.id}>
            <LedgerRow
              event={e}
              ingredient={ingredientById.get(e.entity_id) ?? null}
              stillConfirmedIds={stillConfirmed}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function LedgerRow({
  event,
  ingredient,
  stillConfirmedIds,
}: {
  event: EventRow;
  ingredient: Ingredient | null;
  stillConfirmedIds: Set<string>;
}) {
  const after = event.after ?? {};
  const actor = event.actor ?? "-";

  if (event.kind === "review_confirm") {
    const itemIds = asStringArray(after.item_ids);
    const confirmed = asNumber(after.confirmed) || itemIds.length;
    const usd = asNumber(after.usd);
    const undoableIds = itemIds.filter((id) => stillConfirmedIds.has(id));
    const ingName = ingredient?.name ?? "Unknown ingredient";
    return (
      <article className="kf-review__ledger-row">
        <div className="kf-review__ledger-primary">
          <span className="kf-review__ledger-kind kf-review__ledger-kind--confirm">Confirmed</span>
          <span className="kf-review__ledger-text">
            <strong>{ingName}</strong> - {confirmed} items / ${fmtUsdLong(usd).replace(/^\$/, "")}
          </span>
        </div>
        <div className="kf-review__ledger-meta">
          <span className="kf-review__ledger-when">
            <time dateTime={event.at} title={fmtDate(event.at, "time")}>{timeAgo(event.at)}</time>
          </span>
          <span className="kf-review__ledger-actor">{actor}</span>
          {undoableIds.length > 0 ? (
            <UndoLedgerButton itemIds={undoableIds} />
          ) : (
            <span className="kf-review__ledger-done">Already undone</span>
          )}
        </div>
      </article>
    );
  }

  if (event.kind === "review_undo") {
    return (
      <article className="kf-review__ledger-row kf-review__ledger-row--muted">
        <div className="kf-review__ledger-primary">
          <span className="kf-review__ledger-kind kf-review__ledger-kind--undo">Undid confirm</span>
          <span className="kf-review__ledger-text">Reversed one item back to proposed.</span>
        </div>
        <div className="kf-review__ledger-meta">
          <span className="kf-review__ledger-when">
            <time dateTime={event.at} title={fmtDate(event.at, "time")}>{timeAgo(event.at)}</time>
          </span>
          <span className="kf-review__ledger-actor">{actor}</span>
        </div>
      </article>
    );
  }

  if (event.kind === "ingredient_created") {
    const name = typeof after.name === "string" ? after.name : "ingredient";
    return (
      <article className="kf-review__ledger-row kf-review__ledger-row--muted">
        <div className="kf-review__ledger-primary">
          <span className="kf-review__ledger-kind">Created</span>
          <span className="kf-review__ledger-text">New ingredient <strong>{name}</strong>.</span>
        </div>
        <div className="kf-review__ledger-meta">
          <span className="kf-review__ledger-when">
            <time dateTime={event.at} title={fmtDate(event.at, "time")}>{timeAgo(event.at)}</time>
          </span>
          <span className="kf-review__ledger-actor">{actor}</span>
        </div>
      </article>
    );
  }

  if (event.kind === "ingredient_merged") {
    // Snapshot names from the event itself - the source is now merged
    // so it won't appear in the active ingredients list we have.
    const before = event.before ?? {};
    const sourceName = typeof before.source_name === "string" ? before.source_name : "unknown";
    const targetName = typeof after.target_name === "string" ? after.target_name : "another ingredient";
    const movedItems = asNumber(after.moved_items);
    // Only offer Undo if the source is STILL merged. A re-merged source
    // would resolve as "active" in the ingredients lookup after the
    // undo+re-merge sequence; in that case this row is historical.
    const stillMerged = ingredient === null; // active ingredients map misses merged ones
    return (
      <article className="kf-review__ledger-row">
        <div className="kf-review__ledger-primary">
          <span className="kf-review__ledger-kind">Merged</span>
          <span className="kf-review__ledger-text">
            <strong>{sourceName}</strong> into <strong>{targetName}</strong> - {movedItems} items moved
          </span>
        </div>
        <div className="kf-review__ledger-meta">
          <span className="kf-review__ledger-when">
            <time dateTime={event.at} title={fmtDate(event.at, "time")}>{timeAgo(event.at)}</time>
          </span>
          <span className="kf-review__ledger-actor">{actor}</span>
          {stillMerged ? (
            <UndoMergeButton sourceId={event.entity_id} />
          ) : (
            <span className="kf-review__ledger-done">Already undone</span>
          )}
        </div>
      </article>
    );
  }

  if (event.kind === "ingredient_merge_undo") {
    const before = event.before ?? {};
    const _targetId = typeof before.target_id === "string" ? before.target_id : null;
    void _targetId;
    const restored = asNumber(event.after?.restored_items);
    return (
      <article className="kf-review__ledger-row kf-review__ledger-row--muted">
        <div className="kf-review__ledger-primary">
          <span className="kf-review__ledger-kind kf-review__ledger-kind--undo">Undid merge</span>
          <span className="kf-review__ledger-text">
            {restored > 0 ? <>Restored {restored} items.</> : <>Reversed one merge.</>}
          </span>
        </div>
        <div className="kf-review__ledger-meta">
          <span className="kf-review__ledger-when">
            <time dateTime={event.at} title={fmtDate(event.at, "time")}>{timeAgo(event.at)}</time>
          </span>
          <span className="kf-review__ledger-actor">{actor}</span>
        </div>
      </article>
    );
  }

  const kindLabels: Record<string, string> = {
    review_notfood: "Marked not food",
    review_keep_separate: "Held separate",
    review_relink: "Relinked",
  };
  return (
    <article className="kf-review__ledger-row kf-review__ledger-row--muted">
      <div className="kf-review__ledger-primary">
        <span className="kf-review__ledger-kind">{kindLabels[event.kind] ?? event.kind}</span>
      </div>
      <div className="kf-review__ledger-meta">
        <span className="kf-review__ledger-when">
          <time dateTime={event.at} title={fmtDate(event.at, "time")}>{timeAgo(event.at)}</time>
        </span>
        <span className="kf-review__ledger-actor">{actor}</span>
      </div>
    </article>
  );
}
