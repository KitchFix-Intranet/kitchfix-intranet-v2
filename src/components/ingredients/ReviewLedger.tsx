// Recent decisions / ledger. T4 §4:
//   - all decision kinds appear, review_archive + review_resale +
//     undo included (ReviewLedger used to omit the last two);
//   - every row names the thing - the item (or "3 items") and the
//     ingredient where one exists, with a fallback to the event's own
//     before/after name when the active-ingredients map misses the
//     target (ruling: no row reads "Unknown ingredient" for an event
//     whose names can be found);
//   - a name, never an email - the server derives a display name via
//     nameFromEmail before anything is sent to the browser;
//   - Show more past 25 loads 25 at a time, lazily, on click;
//   - every row for a decision that can still be taken back has an
//     Undo; otherwise the row reads "Changed again since".
//
// Server component. Interactive bits:
//   - <UndoLedgerButton /> for pre-T4 confirms (kept for backward
//     compat with the old itemIds-only confirms still in the table).
//   - <UndoDecisionButton /> for every T4 decision (walks the event
//     via /api/review/undo { eventId }).
//   - <ShowMoreLedger /> is the client island that fetches more 25.

import { serviceClient } from "@/lib/supabase/service";
import { fmtUsdLong, timeAgo, fmtDate, nameFromEmail } from "@/lib/fmt";
import { displayNameFor } from "@/lib/ingredients/itemName";
import { UndoLedgerButton } from "./UndoLedgerButton";
import { UndoMergeButton } from "./UndoMergeButton";
import { UndoDecisionButton } from "./UndoDecisionButton";
import { ShowMoreLedger } from "./ShowMoreLedger";

export type Ingredient = { id: string; name: string; parent: string | null };

// T4: shape of a single event row the ledger renders. Exported for
// the ShowMoreLedger client island so follow-up pages render with
// identical shape.
export type LedgerEventRow = {
  id: string;
  kind: string;
  at: string;
  actor: string | null;
  entity_id: string;
  entity_type: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export const LEDGER_KINDS: readonly string[] = [
  "review_confirm",
  "review_undo",
  "review_notfood",
  "review_oneoff",
  "review_keep_separate",
  "review_relink",
  "review_archive",
  "review_resale",
  "review_restore",
  "ingredient_created",
  "ingredient_split_create",
  "ingredient_revived",
  "ingredient_merged",
  "ingredient_merge_undo",
];

const PAGE_SIZE = 25;

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

// Resolve an actor to a display name. The `actor` column stores an
// email address (historical shape). nameFromEmail returns the local
// part prettified. Never send the raw email further down.
export function actorName(actor: string | null | undefined): string {
  if (!actor) return "-";
  return nameFromEmail(actor);
}

// Resolve an ingredient id to a human name, falling back to names the
// event itself carries. Used so no row reads "Unknown ingredient"
// when the event stored it.
export function resolveIngredientName(
  ingredientId: string | null | undefined,
  byId: Map<string, Ingredient>,
  event: LedgerEventRow,
): string {
  if (ingredientId) {
    const ing = byId.get(ingredientId);
    if (ing) return ing.name;
  }
  // Fallbacks from the event payload. before.name > after.name > before.source_name > after.target_name.
  const b = event.before ?? {};
  const a = event.after ?? {};
  const pick = (k: string, obj: Record<string, unknown>) => {
    const v = obj[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return (
    pick("name", b) ??
    pick("name", a) ??
    pick("source_name", b) ??
    pick("target_name", a) ??
    "Unknown ingredient"
  );
}

export async function ReviewLedger({ ingredients }: { ingredients: Ingredient[] }) {
  const client = serviceClient();
  const { data, error } = await client
    .from("pr_events")
    .select("id,kind,at,actor,entity_id,entity_type,before,after")
    .in("kind", LEDGER_KINDS as unknown as string[])
    .order("at", { ascending: false })
    .limit(PAGE_SIZE);
  if (error) throw error;
  const events = (data ?? []) as LedgerEventRow[];

  if (events.length === 0) {
    return (
      <section className="kf-review__ledger" aria-label="Recent decisions">
        <header className="kf-review__ledger-head">
          <h3>Recent decisions</h3>
          <span>Confirmations, undos and relinks land here.</span>
        </header>
        <p className="kf-review__ledger-empty">
          Nothing yet. Decide on a group above and it will show here.
        </p>
      </section>
    );
  }

  // Which items are still in the state each decision left them in?
  // For review_confirm: still link_status='confirmed'.
  // For every other decision: compare the row's current snapshot
  // against the event's after.items shape. We do one batch read of
  // every mentioned item to avoid N round trips.
  const mentionedIds = new Set<string>();
  for (const e of events) {
    for (const id of asStringArray(e.after?.item_ids)) mentionedIds.add(id);
    for (const row of extractItemObjects(e.after?.items)) mentionedIds.add(row.item_id);
    for (const row of extractItemObjects(e.before?.items)) mentionedIds.add(row.item_id);
  }
  const currentShape = new Map<string, {
    status: string | null;
    link_status: string | null;
    link_reason: string | null;
  }>();
  // T5b ruling 10 + round 2 item 4: one batched read names every
  // item mentioned by the rows on this page, following the SAME
  // precedence the Review card uses (pr_vendor_catalog.clean_name
  // ?? pr_vendor_items.name). Two selects: the items row for state
  // checks + vendor_id + item_number_norm; then one per-vendor
  // catalog read keyed on item_number_norm (same shape
  // loadReview uses).
  const itemNameById = new Map<string, string>();
  type ItemRow = {
    id: string;
    status: string | null;
    link_status: string | null;
    link_reason: string | null;
    vendor_id: string | null;
    item_number_norm: string | null;
    name: string | null;
  };
  const itemRowsById = new Map<string, ItemRow>();
  if (mentionedIds.size > 0) {
    const ids = Array.from(mentionedIds);
    const page = 200;
    for (let i = 0; i < ids.length; i += page) {
      const slice = ids.slice(i, i + page);
      const { data: vi } = await client
        .from("pr_vendor_items")
        .select("id,status,link_status,link_reason,vendor_id,item_number_norm,name")
        .in("id", slice);
      for (const r of (vi ?? []) as ItemRow[]) {
        currentShape.set(r.id, { status: r.status, link_status: r.link_status, link_reason: r.link_reason });
        itemRowsById.set(r.id, r);
      }
    }
  }
  // Catalog join: one read per vendor, bounded by the small list
  // of (vendor_id, item_number_norm) pairs the rows above refer to.
  const catalogCleanByKey = new Map<string, string>();
  if (itemRowsById.size > 0) {
    const byVendor = new Map<string, Set<string>>();
    for (const r of itemRowsById.values()) {
      if (!r.vendor_id || !r.item_number_norm) continue;
      let set = byVendor.get(r.vendor_id);
      if (!set) {
        set = new Set();
        byVendor.set(r.vendor_id, set);
      }
      set.add(r.item_number_norm);
    }
    for (const [vendorId, nums] of byVendor) {
      const list = Array.from(nums);
      const chunk = 500;
      for (let i = 0; i < list.length; i += chunk) {
        const slice = list.slice(i, i + chunk);
        const { data: cat } = await client
          .from("pr_vendor_catalog")
          .select("vendor_id,item_number_norm,clean_name")
          .eq("vendor_id", vendorId)
          .in("item_number_norm", slice);
        for (const c of (cat ?? []) as Array<{ vendor_id: string; item_number_norm: string; clean_name: string | null }>) {
          const name = (c.clean_name ?? "").trim();
          if (name.length > 0) {
            catalogCleanByKey.set(`${c.vendor_id}#${c.item_number_norm}`, name);
          }
        }
      }
    }
  }
  for (const r of itemRowsById.values()) {
    const key =
      r.vendor_id && r.item_number_norm ? `${r.vendor_id}#${r.item_number_norm}` : null;
    const cleanName = key ? catalogCleanByKey.get(key) ?? null : null;
    const name = displayNameFor({ cleanName, name: r.name });
    // displayNameFor floors to "Item"; only record a real match so
    // LedgerRow's "Item" fallback applies when we have nothing.
    if (name !== "Item") itemNameById.set(r.id, name);
  }

  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
  // Precompute the per-row data the client view needs.
  const prepared = events.map((e) => prepareRow(e, ingredientById, currentShape));

  return (
    <section className="kf-review__ledger" aria-label="Recent decisions">
      <header className="kf-review__ledger-head">
        <h3>Recent decisions</h3>
        <span>{`Last ${events.length} actions. Undo reverses any decision from this train on.`}</span>
      </header>
      <ul className="kf-review__ledger-list">
        {prepared.map((row) => (
          <li key={row.event.id}>
            <LedgerRow row={row} ingredientById={ingredientById} itemNameById={itemNameById} />
          </li>
        ))}
      </ul>
      <ShowMoreLedger
        pageSize={PAGE_SIZE}
        oldestAt={events[events.length - 1].at}
      />
    </section>
  );
}

type PreparedRow = {
  event: LedgerEventRow;
  // For item-level decisions: ids and current-state checks.
  itemIds: string[];
  ingredientName: string;
  stillInDecisionState: boolean;
  undoableKind: UndoableKind;
};

type UndoableKind =
  | { kind: "snapshot" }           // T4 decisions - /api/review/undo { eventId }
  | { kind: "legacy_confirm" }     // pre-T4 confirms - UndoLedgerButton on item ids
  | { kind: "merge" }              // ingredient_merged - UndoMergeButton
  | { kind: "none"; reason: string };

function prepareRow(
  event: LedgerEventRow,
  ingredientById: Map<string, Ingredient>,
  current: Map<string, { status: string | null; link_status: string | null; link_reason: string | null }>,
): PreparedRow {
  const after = event.after ?? {};
  const before = event.before ?? {};
  const itemIds = resolveItemIds(event);

  let ingredientName = "";
  // For item-scoped events, the target is on the before.items[0] /
  // after.items[0] snapshot's ingredient_id or on after.ingredient_id;
  // for ingredient-scoped events, event.entity_id is the ingredient.
  const ingId = (after.ingredient_id as string | undefined)
    ?? (event.entity_type === "ingredient" ? event.entity_id : null);
  ingredientName = resolveIngredientName(ingId, ingredientById, event);

  // Decide the Undo kind.
  let undoableKind: UndoableKind;
  if (event.kind === "ingredient_merged") {
    const stillMerged = !ingredientById.has(event.entity_id);
    undoableKind = stillMerged ? { kind: "merge" } : { kind: "none", reason: "Already undone" };
  } else if (event.kind === "review_undo" || event.kind === "ingredient_merge_undo" || event.kind === "ingredient_revived" || event.kind === "ingredient_created") {
    // Terminal events in the ledger - can't un-undo from this surface.
    undoableKind = { kind: "none", reason: "" };
  } else if (hasSnapshot(event)) {
    // T4: every snapshot-bearing decision can walk through
    // undoDecisionEvent. Check that at least one item is still in the
    // state the decision left; otherwise "Changed again since".
    const still = itemIds.length === 0
      ? false
      : itemIds.some((id) => {
          const cur = current.get(id);
          if (!cur) return false;
          return matchesDecisionShape(event.kind, event.after, id, cur);
        });
    undoableKind = still ? { kind: "snapshot" } : { kind: "none", reason: "Changed again since" };
    void before; // unused in this branch
  } else if (event.kind === "review_confirm") {
    // Pre-T4 confirm. Fall back to legacy per-item undo.
    const still = itemIds.length === 0
      ? false
      : itemIds.some((id) => current.get(id)?.link_status === "confirmed");
    undoableKind = still ? { kind: "legacy_confirm" } : { kind: "none", reason: "Already undone" };
  } else {
    undoableKind = { kind: "none", reason: "" };
  }

  return {
    event,
    itemIds,
    ingredientName,
    stillInDecisionState: undoableKind.kind === "snapshot" || undoableKind.kind === "legacy_confirm" || undoableKind.kind === "merge",
    undoableKind,
  };
}

function resolveItemIds(event: LedgerEventRow): string[] {
  const a = event.after ?? {};
  const b = event.before ?? {};
  const fromItemIds = asStringArray(a.item_ids);
  if (fromItemIds.length > 0) return fromItemIds;
  const fromItems = extractItemObjects(a.items).map((r) => r.item_id);
  if (fromItems.length > 0) return fromItems;
  const fromBefore = extractItemObjects(b.items).map((r) => r.item_id);
  if (fromBefore.length > 0) return fromBefore;
  return [];
}

function extractItemObjects(v: unknown): Array<{ item_id: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ item_id: string }> = [];
  for (const r of v) {
    if (r && typeof r === "object" && typeof (r as { item_id?: unknown }).item_id === "string") {
      out.push(r as { item_id: string });
    }
  }
  return out;
}

function hasSnapshot(event: LedgerEventRow): boolean {
  const before = event.before ?? {};
  return extractItemObjects(before.items).length > 0;
}

// Does the current row still match what the decision set? If yes, the
// decision is still undoable. If not, something else wrote the row
// and Undo refuses with the "Changed again since" sentence.
function matchesDecisionShape(
  kind: string,
  after: Record<string, unknown> | null,
  itemId: string,
  cur: { status: string | null; link_status: string | null; link_reason: string | null },
): boolean {
  const afterItems = extractItemObjects(after?.items as unknown);
  const want = (afterItems as Array<{ item_id: string; status?: unknown; link_status?: unknown; link_reason?: unknown }>)
    .find((x) => x.item_id === itemId);
  if (want) {
    if (typeof want.status === "string" && want.status !== cur.status) return false;
    if (typeof want.link_status === "string" && want.link_status !== cur.link_status) return false;
    // link_reason comparison is exact for new-shape rows; after the
    // correction every row will use the verb-only form so this is
    // byte-equal. For legacy (pre-correction) rows the stored
    // link_reason may carry an email tail - but a snapshot-bearing
    // event is only emitted by T4 code paths, so after.items carries
    // the new verb and the row's current link_reason matches.
    if (typeof want.link_reason === "string" && want.link_reason !== cur.link_reason) return false;
    return true;
  }
  // No after.items shape (e.g. pre-T4 confirm). Fall back to kind-level
  // checks.
  if (kind === "review_confirm") return cur.link_status === "confirmed";
  return true;
}

function LedgerRow({
  row,
  ingredientById,
  itemNameById,
}: {
  row: PreparedRow;
  ingredientById: Map<string, Ingredient>;
  itemNameById: Map<string, string>;
}) {
  const { event } = row;
  const after = event.after ?? {};
  const name = actorName(event.actor);

  // T5b ruling 10: on a decision that touched one item, the bold
  // subject is the item's current description. "Item" is the
  // fallback when the row was renamed or removed. For item-scoped
  // events from before train 4 that stored no after.item_ids /
  // after.count, we treat them as one-item events named by the
  // event's own entity_id.
  function singleItemId(): string | null {
    if (row.itemIds.length === 1) return row.itemIds[0];
    if (row.itemIds.length === 0 && event.entity_type === "vendor_item") {
      return event.entity_id;
    }
    return null;
  }
  function singleItemName(): string | null {
    const id = singleItemId();
    if (!id) return null;
    const n = itemNameById.get(id);
    return n && n.length > 0 ? n : "Item";
  }
  // T5b ruling 10 (+pre-T4 heal): item-scoped events pre-T4 wrote
  // one row per item without an after.item_ids / after.count. A
  // sensible count is 1 when the event names a single vendor_item.
  const pre4SingleItem =
    row.itemIds.length === 0 && event.entity_type === "vendor_item" ? 1 : 0;

  if (event.kind === "review_confirm") {
    const confirmed = asNumber(after.confirmed) || row.itemIds.length;
    const usd = asNumber(after.usd);
    const wasRetail = Boolean(after.ingredient_is_retail) || asNumber(after.moved_to_resale) > 0;
    const verb = wasRetail ? "Confirmed as retail" : "Confirmed";
    const subject =
      confirmed === 1 ? (singleItemName() ?? "Item") : row.ingredientName;
    const detail =
      confirmed === 1
        ? `to ${row.ingredientName} · $${fmtUsdLong(usd).replace(/^\$/, "")}`
        : `${confirmed} items · $${fmtUsdLong(usd).replace(/^\$/, "")}`;
    return (
      <LedgerRowFrame
        kind={verb}
        text={<><strong>{subject}</strong> <small>{detail}</small></>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_resale") {
    const items = row.itemIds.length || pre4SingleItem;
    const subject = items === 1 ? (singleItemName() ?? "Item") : row.ingredientName;
    const detail = items === 1 ? "to Retail" : `${items} items`;
    return (
      <LedgerRowFrame
        kind="Marked retail"
        text={<><strong>{subject}</strong> <small>{detail}</small></>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_archive") {
    const count = asNumber(after.count) || row.itemIds.length || pre4SingleItem;
    const subject = count === 1 ? (singleItemName() ?? "Item") : `${count} items`;
    return (
      <LedgerRowFrame
        kind="Archived"
        text={<><strong>{subject}</strong></>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_oneoff") {
    const count = row.itemIds.length || pre4SingleItem;
    const subject = count === 1 ? (singleItemName() ?? "Item") : `${count} items`;
    return (
      <LedgerRowFrame
        kind="Marked one-off"
        text={<><strong>{subject}</strong></>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_notfood") {
    const count = row.itemIds.length || pre4SingleItem;
    const subject = count === 1 ? (singleItemName() ?? "Item") : `${count} items`;
    return (
      <LedgerRowFrame
        kind="Marked not food"
        text={<><strong>{subject}</strong></>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_keep_separate") {
    const count = row.itemIds.length || pre4SingleItem;
    const subject = count === 1 ? (singleItemName() ?? "Item") : `${count} items`;
    return (
      <LedgerRowFrame
        kind="Held separate"
        text={<><strong>{subject}</strong></>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_relink") {
    const count = row.itemIds.length || pre4SingleItem;
    const subject = count === 1 ? (singleItemName() ?? "Item") : `${count} items`;
    const detail = `to ${row.ingredientName}`;
    return (
      <LedgerRowFrame
        kind="Relinked"
        text={<><strong>{subject}</strong> <small>{detail}</small></>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_restore") {
    return (
      <LedgerRowFrame
        kind="Restored"
        text={<>1 item back to not matched yet</>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "review_undo") {
    const items = row.itemIds.length || pre4SingleItem;
    const subject =
      items === 1 ? (singleItemName() ?? "Item") : `${items} items`;
    return (
      <LedgerRowFrame
        kind="Undid"
        text={<><strong>{subject}</strong></>}
        at={event.at}
        name={name}
        row={row}
        muted
      />
    );
  }

  if (event.kind === "ingredient_created") {
    const n = typeof after.name === "string" ? after.name : "ingredient";
    return (
      <LedgerRowFrame
        kind="Created"
        text={<>New ingredient <strong>{n}</strong>.</>}
        at={event.at}
        name={name}
        row={row}
        muted
      />
    );
  }

  if (event.kind === "ingredient_split_create") {
    const n = typeof after.name === "string" ? after.name : row.ingredientName;
    const items = row.itemIds.length;
    const createKind = after.create_kind;
    const verb = createKind === "revived_retired"
      ? "Revived"
      : createKind === "matched_active"
        ? "Added"
        : "Created";
    const subject = createKind === "matched_active"
      ? <>{items === 1 ? "1 item" : `${items} items`} to <strong>{n}</strong></>
      : <>{n} with {items === 1 ? "1 item" : `${items} items`}</>;
    return (
      <LedgerRowFrame
        kind={verb}
        text={subject}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "ingredient_revived") {
    const n = typeof (after.name) === "string" ? after.name : row.ingredientName;
    return (
      <LedgerRowFrame
        kind="Revived"
        text={<><strong>{n}</strong> back to active.</>}
        at={event.at}
        name={name}
        row={row}
        muted
      />
    );
  }

  if (event.kind === "ingredient_merged") {
    const before = event.before ?? {};
    const sourceName = typeof before.source_name === "string" ? before.source_name : "unknown";
    const targetName = typeof after.target_name === "string" ? after.target_name : "another ingredient";
    const movedItems = asNumber(after.moved_items);
    return (
      <LedgerRowFrame
        kind="Merged"
        text={<><strong>{sourceName}</strong> into <strong>{targetName}</strong> - {movedItems} items moved</>}
        at={event.at}
        name={name}
        row={row}
      />
    );
  }

  if (event.kind === "ingredient_merge_undo") {
    const restored = asNumber(event.after?.restored_items);
    return (
      <LedgerRowFrame
        kind="Undid merge"
        text={restored > 0 ? <>Restored {restored} items.</> : <>Reversed one merge.</>}
        at={event.at}
        name={name}
        row={row}
        muted
      />
    );
  }

  // Unknown kind - render the raw row with the kind as the label so
  // nothing silently disappears.
  return (
    <LedgerRowFrame
      kind={event.kind}
      text={<>&nbsp;</>}
      at={event.at}
      name={name}
      row={row}
      muted
    />
  );
  void ingredientById; // reserved for future per-kind renderers
}

function LedgerRowFrame({
  kind,
  text,
  at,
  name,
  row,
  muted,
}: {
  kind: string;
  text: React.ReactNode;
  at: string;
  name: string;
  row: PreparedRow;
  muted?: boolean;
}) {
  return (
    <article className={`kf-review__ledger-row${muted ? " kf-review__ledger-row--muted" : ""}`}>
      <div className="kf-review__ledger-primary">
        <span className="kf-review__ledger-kind">{kind}</span>
        <span className="kf-review__ledger-text">{text}</span>
      </div>
      <div className="kf-review__ledger-meta">
        <span className="kf-review__ledger-when">
          <time dateTime={at} title={fmtDate(at, "time")}>{timeAgo(at)}</time>
        </span>
        <span className="kf-review__ledger-actor">{name}</span>
        <LedgerUndoControl row={row} />
      </div>
    </article>
  );
}

function LedgerUndoControl({ row }: { row: PreparedRow }) {
  const u = row.undoableKind;
  if (u.kind === "snapshot") {
    return <UndoDecisionButton eventId={row.event.id} />;
  }
  if (u.kind === "legacy_confirm") {
    return <UndoLedgerButton itemIds={row.itemIds} />;
  }
  if (u.kind === "merge") {
    return <UndoMergeButton sourceId={row.event.entity_id} />;
  }
  if (u.reason) {
    return <span className="kf-review__ledger-done">{u.reason}</span>;
  }
  return null;
}
