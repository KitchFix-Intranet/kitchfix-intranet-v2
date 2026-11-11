"use client";

// Stateless action bar for a review card. Selection state (which items
// are checked) lives in the parent ReviewCard - this component just
// receives the already-filtered checkedIds + a few summary fields and
// acts on them. The former "Pick individual items" expander is gone;
// every item row carries a visible checkbox now (ReviewCard owns the
// per-row rendering).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X as XIcon, Plus, Scissors, Ban, Search, ShoppingBag, Archive, Loader2, Flag, Clock } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd } from "@/lib/fmt";
import { SUPER_CATEGORIES, categoryForParent, type SuperCategory } from "@/lib/ingredients/categories";
import { IngredientTypeahead } from "./IngredientTypeahead";

// Kept exported so other call sites that import it keep compiling even
// though ReviewCard no longer passes a memberItems prop.
export type ReviewMemberItem = {
  id: string;
  name: string;
  confidence: string | null;
};

// Minimal item shape used by the New-ingredient form to preview the
// members Kevin is building the new ingredient from. ReviewCard
// supplies a subset of each ReviewGroupItem.
export type NewIngredientPreviewItem = {
  id: string;
  displayName: string;
  vendor: string;
  pack: string | null;
  billedUnit: string | null;
  usd12m: number;
};

type Ingredient = { id: string; name: string; parent: string | null };

type Props = {
  kind: "existing" | "new";
  currentIngredientId: string | null;
  // Whether the current target ingredient is Retail. On existing-group
  // confirms with this true, confirmItems lands the items as
  // status='resale' instead of 'active' (S1). Null when there is no
  // existing ingredient (ai-new groups).
  ingredientResale?: boolean;
  proposedName: string | null;
  proposedParent: string | null;
  ingredients: Ingredient[];
  checkedIds: string[];
  checkedItems: NewIngredientPreviewItem[];
  checkedCount: number;
  memberCount: number;
  // Called by ReviewActions after a successful Confirm so the parent
  // ReviewCard can play its leaving-animation before calling
  // router.refresh(). Fires BEFORE the undo toast lands so the two
  // animations overlap. Receives the item ids that just left the queue.
  onLeaveStart?: (itemIds: string[]) => void;
};

type Op = null | "confirming" | "relinking" | "creating" | "notfood" | "resale" | "archived" | "oneoff" | "keepsep" | "flag";

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

function errMsg(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return fallback;
}

// N4: Create-success toasts that name a master append the inferred
// unit when it is not the common-case default "each". Keeps the usual
// case (single-serve items, retail packaged goods) quiet and makes
// the inferred cases visible.
function unitSuffix(baseUnit: unknown): string {
  if (baseUnit !== "lb" && baseUnit !== "gal" && baseUnit !== "dozen") return "";
  return ` (per ${baseUnit})`;
}

export function ReviewActions({
  kind,
  currentIngredientId,
  ingredientResale,
  proposedName,
  proposedParent,
  ingredients,
  checkedIds,
  checkedItems,
  checkedCount,
  memberCount,
  onLeaveStart,
}: Props) {
  const router = useRouter();
  const [op, setOp] = useState<Op>(null);
  // Shared save-status strip. `lastDone` is the clock stamp of the
  // most recent successful action; a 2.5s window after that renders
  // the inline "Done" chip. The strip renders "Saving..." any time
  // an op is in flight, so every save point here has a consistent
  // in-flight + success indicator (matches the DetailPanel SaveFlash
  // pattern per the Oct 29 Britt review).
  const [lastDone, setLastDone] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    if (!lastDone) {
      setShowDone(false);
      return;
    }
    setShowDone(true);
    const t = window.setTimeout(() => setShowDone(false), 2500);
    return () => window.clearTimeout(t);
  }, [lastDone]);
  const [showRelink, setShowRelink] = useState(false);
  const [relinkId, setRelinkId] = useState<string | null>(null);
  const [newName, setNewName] = useState(proposedName ?? "");
  // Pre-fill the super-category + sub-category from the matcher's
  // proposed parent (if any). Both are REQUIRED on submit - the form's
  // Create button is disabled until both are set (a sub-category pick
  // or a new sub-category text), plus a non-empty name.
  const [newSuper, setNewSuper] = useState<SuperCategory | "">(() => {
    return (categoryForParent(proposedParent) as SuperCategory | null) ?? "";
  });
  const [subMode, setSubMode] = useState<"pick" | "new">(
    proposedParent ? "pick" : "pick"
  );
  const [subPick, setSubPick] = useState<string>(proposedParent ?? "");
  const [subNew, setSubNew] = useState<string>("");
  const [showNew, setShowNew] = useState(false);
  // Q2 §1: default CHECKED. Pre-Q2 shape was create -> find new card ->
  // confirm (two round trips). Checked makes the one action do both;
  // unchecked preserves today's two-step behaviour exactly. Setting
  // state lives in the create panel and does not persist across
  // panel open/close - reset-on-open is intentional (R-112 pattern).
  const [createAndConfirm, setCreateAndConfirm] = useState(true);
  // N3: why the user opened the create panel. "confirm" is the plain
  // + Create flow (default). "retail" is set only by the markResale
  // fallback below when it cannot post directly (name < 2 chars or
  // the proposed parent is not in CATEGORY_BY_PARENT). In the retail
  // intent the panel's primary button reads "Create and mark retail",
  // the create-and-confirm checkbox is hidden, and doCreateSplit
  // posts { confirm: true, resale: true }. Reset to "confirm"
  // wherever setShowNew(false) runs so a stale intent cannot leak
  // into the next plain Create.
  const [createIntent, setCreateIntent] = useState<"confirm" | "retail">("confirm");

  // Parents available for the sub dropdown: distinct parents from the
  // active ingredients list. Deduped + sorted.
  const parentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of ingredients) if (i.parent && i.parent.trim().length > 0) set.add(i.parent);
    return Array.from(set).sort();
  }, [ingredients]);

  const noneChecked = checkedCount === 0;
  const effectiveSub =
    subMode === "new" ? subNew.trim() : subPick;
  const newFormReady =
    newName.trim().length >= 2 &&
    newSuper !== "" &&
    effectiveSub.length > 0;

  async function confirmChecked() {
    if (op || noneChecked) return;
    if (kind === "new") {
      // N4 P3-close: the create panel is shared with the markResale
      // fallback, which sets createIntent='retail'. Opening it from
      // the plain +Create button must reset the intent, otherwise a
      // user who cancels a retail fallback and then presses +Create
      // lands on a panel whose primary button still reads "Create and
      // mark retail". One line here closes the leak at every entry.
      setCreateIntent("confirm");
      setShowNew(true);
      return;
    }
    if (!currentIngredientId) {
      toast("No ingredient target for this group", { tone: "block" });
      return;
    }
    setOp("confirming");
    const r = await postJson("/api/review/confirm", {
      ingredientId: currentIngredientId,
      itemIds: checkedIds,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Confirm failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    const d = r.data as { confirmed?: number; movedToResale?: number };
    const confirmedIds = [...checkedIds];
    const movedToResale = d.movedToResale ?? 0;
    const base = `Confirmed ${fmtCount(d.confirmed ?? checkedCount)} items`;
    toast(
      movedToResale > 0
        ? `${base} (${fmtCount(movedToResale)} landed as retail)`
        : base,
      {
        tone: "good",
        undo: async () => {
          for (const id of confirmedIds) {
            await postJson("/api/review/undo", { itemId: id });
          }
          router.refresh();
        },
      }
    );
    setOp(null);
    setLastDone(Date.now());
    // Hand off to the parent card for the leaving-animation + the
    // deferred router.refresh() (so the card unmounts AFTER the
    // animation plays). If no handler is wired, refresh immediately
    // like before.
    if (onLeaveStart) {
      onLeaveStart(confirmedIds);
    } else {
      router.refresh();
    }
  }

  async function relinkChecked() {
    if (op || noneChecked || !relinkId) return;
    setOp("relinking");
    const r = await postJson("/api/review/relink", {
      ingredientId: relinkId,
      itemIds: checkedIds,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Relink failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    toast("Relinked");
    setShowRelink(false);
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
  }

  // Split-to-new-ingredient. The chosen items get reassigned to the
  // new ingredient and stay link_status='proposed' so Kevin can see the
  // split in the queue under the new ingredient's own card. Confirm is
  // a separate step on that new card (fixes the "the one I moved
  // disappeared" / "still falls under the group I removed it from"
  // complaints).
  async function doCreateSplit() {
    if (op || noneChecked) return;
    const name = newName.trim();
    if (!newFormReady) {
      toast(
        name.length < 2
          ? "Ingredient name is required"
          : newSuper === ""
            ? "Pick a category"
            : "Pick or type a sub-category",
        { tone: "block" }
      );
      return;
    }
    setOp("creating");
    // N3: in the retail intent the panel's payload forces confirm +
    // resale regardless of the checkbox state (the checkbox is hidden
    // in that intent, see the panel render below). In the default
    // "confirm" intent the payload is byte-identical to pre-N3.
    const isRetail = createIntent === "retail";
    const r = await postJson("/api/review/new-ingredient", {
      name,
      parent: effectiveSub || null,
      category: newSuper || null,
      itemIds: checkedIds,
      // Q2 §1: when the checkbox is on, the server runs confirm in the
      // same request, through the same confirmItems() path a normal
      // confirm uses. If the box is off, server behaviour is exactly
      // today's (create + split, link_status stays 'proposed'). Both
      // paths return {ingredientId, moved}; the atomic path also
      // returns {confirmed, usd, movedToResale?} from confirmItems.
      //
      // N3: retail intent implies confirm=true and additionally sends
      // resale=true, so the server picks markResale() instead of
      // confirmItems() and the items land as status='resale'.
      confirm: isRetail ? true : createAndConfirm,
      resale: isRetail,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Create failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    const d = r.data as {
      ingredientId?: string;
      moved?: number;
      confirmed?: number;
      marked?: number;
      movedToResale?: number;
      baseUnit?: string;
    };
    const moved = d.moved ?? checkedCount;
    // N4: inferred unit suffix - empty string for "each" / missing,
    // " (per lb)" / " (per gal)" / " (per dozen)" otherwise.
    const unit = unitSuffix(d.baseUnit);
    if (isRetail) {
      // N3 retail intent: the fallback form path. Partial-atomicity
      // is the same as the confirm path - if markResale throws after
      // create+move landed, the ingredient exists and the items sit
      // on it in link_status='proposed', so the user retries from
      // the new card. Already blocked by the !r.ok branch above.
      const n = d.marked ?? d.confirmed ?? moved;
      toast(`Created "${name}"${unit} and marked ${fmtCount(n)} item${n === 1 ? "" : "s"} as retail`);
    } else if (createAndConfirm) {
      // Partial-atomicity note: the create -> move -> confirm sequence
      // runs as three successive statements in new-ingredient/route.ts;
      // if confirm fails after create+move lands, the ingredient
      // exists and the items sit on it in link_status='proposed' -
      // i.e. the same state the no-confirm path produces. Not a new
      // failure mode; the user just has to open the new card and
      // retry confirm. Toast on partial failure is already blocked by
      // the !r.ok branch above.
      const confirmed = d.confirmed ?? moved;
      toast(`Created "${name}"${unit} and confirmed ${fmtCount(confirmed)} item${confirmed === 1 ? "" : "s"}`);
    } else {
      toast(
        `Created "${name}"${unit} - ${fmtCount(moved)} items moved; confirm them on the new card.`
      );
    }
    setShowNew(false);
    setCreateAndConfirm(true);
    setCreateIntent("confirm");
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
  }

  async function markNotFood() {
    if (op || noneChecked) return;
    setOp("notfood");
    const r = await postJson("/api/review/not-food", { itemIds: checkedIds });
    if (!r.ok) {
      toast(errMsg(r.data, `Mark failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    toast(`Marked ${fmtCount(checkedCount)} as not food`);
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
  }

  // Q2 §2: One-off purchase disposition. Real food bought once that
  // doesn't deserve its own master (160 items in the current
  // queue). Same write set as markNotFood BUT with a 'oneoff:' reason
  // prefix instead of 'notfood:' so later analysis can find the
  // population. is_food stays true (it IS food) - this is a DISPOSITION,
  // not a re-classification. Reuses the archive-and-reject path to stay
  // out of the coverage meters without inventing a new column.
  async function markOneOff() {
    if (op || noneChecked) return;
    setOp("oneoff");
    const r = await postJson("/api/review/one-off", { itemIds: checkedIds });
    if (!r.ok) {
      toast(errMsg(r.data, `Mark failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    toast(`Marked ${fmtCount(checkedCount)} as one-off purchase${checkedCount === 1 ? "" : "s"}`);
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
  }

  // Retail disposition. Items sold as-is to players (bottled water,
  // snacks, pre-made sandwiches): real spend but not a recipe
  // ingredient. B7: this action now confirms the link (so the item
  // prices on the Retail tab) AND marks the item retail. It does
  // NOT touch the master's retail flag - a master can hold a mix.
  // The toast names the ingredient-stays-recipe case explicitly so
  // the user isn't left wondering why the ingredient didn't move.
  async function markResale() {
    if (op || noneChecked) return;

    // N3: ai-new one-click path. There is no ingredient yet, but the
    // matcher has already supplied everything the create form would
    // have asked for - its initial state at lines 116, 121, 127 reads
    // exactly these three values. Post them straight to
    // /api/review/new-ingredient with { confirm: true, resale: true }
    // so the server creates the master, confirms the items onto it,
    // and stamps status='resale' in one action. The master's own
    // resale flag stays off (B7 ruling, honoured on the server too).
    // No undo: undoConfirm only reverts link_status, not status, so a
    // control here would half-work and mislead (same reason the
    // existing-ingredient Retail path has none).
    if (kind === "new") {
      const name = (proposedName ?? "").trim();
      const parent = proposedParent;
      const category = categoryForParent(parent);
      // Fallback: open the create panel with retail intent when name
      // or category is missing. Measured frequency on live Postgres
      // 2026-11-09 is zero (every ai-new group carries a proposed_name
      // and PR #18 mapped the last two parents, so categoryForParent
      // resolves on 893 of 893), but a future matcher run can emit a
      // parent not yet in CATEGORY_BY_PARENT and the user must get a
      // form rather than a silent failure or a junk master with a null
      // category. The form, when opened this way, writes
      // { confirm: true, resale: true } through doCreateSplit.
      if (name.length < 2 || category == null) {
        setCreateIntent("retail");
        setShowNew(true);
        return;
      }
      setOp("resale");
      const r = await postJson("/api/review/new-ingredient", {
        name,
        parent,
        category,
        itemIds: checkedIds,
        confirm: true,
        resale: true,
      });
      if (!r.ok) {
        toast(errMsg(r.data, `Mark failed (${r.status})`), { tone: "block" });
        setOp(null);
        return;
      }
      const d = r.data as { confirmed?: number; marked?: number; baseUnit?: string };
      const n = d.marked ?? d.confirmed ?? checkedCount;
      // Name the master in the toast - the user did not see a form.
      // N4: append the unit when it is not the common-case default
      // "each" so the user sees that the server inferred something
      // other than the usual.
      toast(
        `Created "${name}"${unitSuffix(d.baseUnit)} and marked ${fmtCount(n)} item${n === 1 ? "" : "s"} as retail`,
        { tone: "good" }
      );
      setOp(null);
      setLastDone(Date.now());
      if (onLeaveStart) {
        onLeaveStart(checkedIds);
      } else {
        router.refresh();
      }
      return;
    }

    // Existing-ingredient path - unchanged. Guard still protects it:
    // kind === "existing" without a currentIngredientId would be a
    // corrupt group shape and should block, not silently create a new
    // master.
    if (!currentIngredientId) {
      toast("No ingredient target for this group", { tone: "block" });
      return;
    }
    setOp("resale");
    const r = await postJson("/api/review/resale", {
      ingredientId: currentIngredientId,
      itemIds: checkedIds,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Mark failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    const d = r.data as { confirmed?: number; marked?: number; ingredientIsRetail?: boolean };
    const n = d.marked ?? d.confirmed ?? checkedCount;
    const msg = d.ingredientIsRetail
      ? `Marked ${fmtCount(n)} as retail`
      : `Marked ${fmtCount(n)} as retail - the ingredient is still a recipe ingredient. Flip its Retail toggle in the detail panel to move the whole ingredient.`;
    toast(msg, { tone: "good" });
    setOp(null);
    setLastDone(Date.now());
    if (onLeaveStart) {
      onLeaveStart(checkedIds);
    } else {
      router.refresh();
    }
  }

  // Archive disposition. IS-food items that are one-offs / irrelevant
  // purchases - not recipe ingredients, not retail. The overview views
  // only count status in ('active','resale'), so status='archived'
  // drops the item from both recipe coverage AND retail totals;
  // link_status='rejected' keeps the matcher away.
  async function markArchived() {
    if (op || noneChecked) return;
    setOp("archived");
    const r = await postJson("/api/review/archive", { itemIds: checkedIds });
    if (!r.ok) {
      toast(errMsg(r.data, `Mark failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    toast(`Archived ${fmtCount(checkedCount)} item${checkedCount === 1 ? "" : "s"}`);
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
  }

  // Flag. Orthogonal to disposition - doesn't move anything, just
  // stamps flagged/flag_note/flagged_by/flagged_at. A follow-up
  // reviewer sees these on the Overview flagged panel. Unflag/resolve
  // happens from that panel. Prompts for an optional short note.
  async function flagChecked() {
    if (op || noneChecked) return;
    // eslint-disable-next-line no-alert
    const note = window.prompt(
      `Flag ${checkedCount} item${checkedCount === 1 ? "" : "s"} for a second look. Optional note:`,
      ""
    );
    if (note === null) return; // user cancelled
    setOp("flag");
    const r = await postJson("/api/review/flag", {
      itemIds: checkedIds,
      flagged: true,
      note: note.trim() || null,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Flag failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    toast(`Flagged ${fmtCount(checkedCount)} item${checkedCount === 1 ? "" : "s"} for review`);
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
  }

  async function keepSeparate() {
    if (op || noneChecked) return;
    setOp("keepsep");
    const r = await postJson("/api/review/keep-separate", { itemIds: checkedIds });
    if (!r.ok) {
      toast(errMsg(r.data, `Mark failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    toast(`${fmtCount(checkedCount)} items held out of this group`);
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
  }

  return (
    <div className="kf-rvc__actions">
      <div className="kf-rvc__actions-summary">
        <span>
          <strong>{fmtCount(checkedCount)}</strong> of {fmtCount(memberCount)} selected
        </span>
        {op !== null ? (
          <span className="kf-rvc__status kf-rvc__status--busy" aria-live="polite">
            <Loader2 size={12} strokeWidth={2.5} className="kf-rvc__spin" aria-hidden />
            Saving...
          </span>
        ) : showDone ? (
          <span className="kf-rvc__status kf-rvc__status--done" aria-live="polite">
            <Check size={12} strokeWidth={2.5} aria-hidden />
            Done
          </span>
        ) : null}
      </div>

      <div className="kf-rvc__btns">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${op === "confirming" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={confirmChecked}
        >
          <Check size={14} strokeWidth={1.5} />
          <span>
            {op === "confirming"
              ? "Saving..."
              : kind === "new"
                ? "Create ingredient"
                : ingredientResale
                  ? "Confirm as retail"
                  : "Confirm"}
          </span>
        </button>

        <button
          type="button"
          className="kf-btn kf-btn--line kf-btn--sm"
          disabled={op !== null || noneChecked}
          onClick={() => setShowRelink((v) => !v)}
        >
          <Search size={14} strokeWidth={1.5} />
          <span>Relink</span>
        </button>

        {kind === "existing" ? (
          <button
            type="button"
            className="kf-btn kf-btn--line kf-btn--sm"
            disabled={op !== null || noneChecked}
            onClick={() => setShowNew((v) => !v)}
          >
            <Plus size={14} strokeWidth={1.5} />
            <span>New ingredient</span>
          </button>
        ) : null}

        <button
          type="button"
          className={`kf-btn kf-btn--ghost kf-btn--sm${op === "keepsep" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={keepSeparate}
          title="Hold these items out of this group permanently"
        >
          <Scissors size={14} strokeWidth={1.5} />
          <span>{op === "keepsep" ? "Saving..." : "Keep separate"}</span>
        </button>

        <button
          type="button"
          className={`kf-btn kf-btn--ghost kf-btn--sm${op === "flag" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={flagChecked}
          title="Mark for a second look (optional note); stays in the queue, shows on the Overview flagged panel"
        >
          <Flag size={14} strokeWidth={1.5} />
          <span>{op === "flag" ? "Saving..." : "Flag"}</span>
        </button>

        {/* Q2 §2 addition: divider between "adjust this group" (Keep
            separate, Flag) and "remove from queue" (Retail, Archive,
            One-off, Not food). Six near-identical ghost buttons was
            too many without a cluster break. The split reads as
            intent, not just chrome. */}
        <span className="kf-rvc__dispo-divider" aria-hidden />

        <button
          type="button"
          className={`kf-btn kf-btn--ghost kf-btn--sm${op === "resale" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={markResale}
          title="Sold as-is to players (water, snacks, sandwiches); tracked as retail spend, not a recipe ingredient"
        >
          <ShoppingBag size={14} strokeWidth={1.5} />
          <span>{op === "resale" ? "Saving..." : "Retail"}</span>
        </button>

        <button
          type="button"
          className={`kf-btn kf-btn--ghost kf-btn--sm${op === "archived" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={markArchived}
          title="Mistake or dead item; parked and not tracked in recipe coverage or retail"
        >
          <Archive size={14} strokeWidth={1.5} />
          <span>{op === "archived" ? "Saving..." : "Archive"}</span>
        </button>

        {/* Q2 §2: One-off purchase. Sibling of Archive and Not food,
            not a competitor to Confirm. Clock icon reads as "bought
            once". */}
        <button
          type="button"
          className={`kf-btn kf-btn--ghost kf-btn--sm${op === "oneoff" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={markOneOff}
          title="Real food bought once that doesn't deserve a master (parked, not tracked in recipe coverage or retail)"
        >
          <Clock size={14} strokeWidth={1.5} />
          <span>{op === "oneoff" ? "Saving..." : "One-off"}</span>
        </button>

        <button
          type="button"
          className={`kf-btn kf-btn--ghost kf-btn--sm${op === "notfood" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={markNotFood}
          title="Not a consumable product (fees, freight, supplies)"
        >
          <Ban size={14} strokeWidth={1.5} />
          <span>{op === "notfood" ? "Saving..." : "Not food"}</span>
        </button>
      </div>

      <div className="kf-rvc__dispo-help" role="note">
        <strong>Confirm</strong> = recipe ingredient &middot; <strong>Retail</strong> = sold as-is
        (water, snacks, sandwiches) &middot; <strong>Archive</strong> = mistake / dead item
        &middot; <strong>One-off</strong> = bought once &middot; <strong>Not food</strong> =
        fees / supplies.
      </div>

      {showRelink ? (
        <div className="kf-rvc__panel">
          <IngredientTypeahead
            ingredients={ingredients}
            excludeId={currentIngredientId ?? undefined}
            label="Reassign to"
            placeholder="Type to search ingredients..."
            pickedId={relinkId}
            onPick={(id) => setRelinkId(id)}
            busy={op !== null}
          />
          <div className="kf-rvc__panel-btns">
            <button
              type="button"
              className={`kf-btn kf-btn--primary kf-btn--sm${op === "relinking" ? " is-busy" : ""}`}
              disabled={op !== null || !relinkId}
              onClick={relinkChecked}
            >
              Relink and leave as proposed
            </button>
            <button
              type="button"
              className="kf-btn kf-btn--ghost kf-btn--sm"
              onClick={() => setShowRelink(false)}
              disabled={op !== null}
            >
              <XIcon size={14} strokeWidth={1.5} />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      ) : null}

      {showNew ? (
        <div className="kf-rvc__panel kf-newing">
          <div className="kf-newing__intro">
            Create a new ingredient from the {fmtCount(checkedCount)} selected item{checkedCount === 1 ? "" : "s"}.
            {createAndConfirm ? (
              ""
            ) : (
              <> It&rsquo;ll land in the queue under its own card so you can confirm there.</>
            )}
          </div>

          <label className="kf-dpn__label">
            <span>Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={proposedName ?? "e.g. Smoked paprika"}
              autoFocus
            />
          </label>

          <div className="kf-newing__row">
            <label className="kf-dpn__label">
              <span>Category *</span>
              <select
                value={newSuper}
                onChange={(e) => setNewSuper(e.target.value as SuperCategory | "")}
                required
              >
                <option value="">Pick a category...</option>
                {SUPER_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="kf-dpn__label">
              <span>Sub-category *</span>
              {subMode === "pick" ? (
                <select value={subPick} onChange={(e) => setSubPick(e.target.value)} required>
                  <option value="">Pick a sub-category...</option>
                  {parentOptions.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={subNew}
                  onChange={(e) => setSubNew(e.target.value)}
                  placeholder="New sub-category name"
                />
              )}
            </label>
          </div>
          <button
            type="button"
            className="kf-newing__sub-toggle"
            onClick={() => setSubMode((m) => (m === "pick" ? "new" : "pick"))}
          >
            {subMode === "pick" ? "+ add new sub-category" : "pick an existing sub-category"}
          </button>

          {checkedItems.length > 0 ? (
            <div className="kf-newing__preview" aria-label="Items being used to create this ingredient">
              <div className="kf-newing__preview-head">
                Items being used: <strong>{fmtCount(checkedItems.length)}</strong>
              </div>
              <ul>
                {checkedItems.slice(0, 8).map((it) => (
                  <li key={it.id}>
                    <div className="kf-newing__preview-name">{it.displayName}</div>
                    <div className="kf-newing__preview-meta">
                      <span>{it.vendor}</span>
                      <span className="kf-muted">
                        · {it.pack ?? "-"} / {it.billedUnit ?? "-"}
                      </span>
                      <span className="kf-newing__preview-usd">{fmtUsd(it.usd12m)}</span>
                    </div>
                  </li>
                ))}
                {checkedItems.length > 8 ? (
                  <li className="kf-newing__preview-more">+ {checkedItems.length - 8} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {/* Q2 §1: create-and-confirm checkbox. Default checked.
              Unchecking reproduces the pre-Q2 two-step flow exactly.
              N3: hidden in the retail intent - the payload is forced
              to confirm=true, resale=true in doCreateSplit, and
              showing an unchecked-able checkbox would mislead. */}
          {createIntent !== "retail" && (
            <label className="kf-newing__confirm" title="Create the ingredient and confirm the selected items on it in one action">
              <input
                type="checkbox"
                checked={createAndConfirm}
                onChange={(e) => setCreateAndConfirm(e.target.checked)}
                disabled={op !== null}
              />
              <span>Confirm these items on the new ingredient</span>
            </label>
          )}

          <div className="kf-rvc__panel-btns">
            <button
              type="button"
              className={`kf-btn kf-btn--primary kf-btn--sm${op === "creating" ? " is-busy" : ""}`}
              disabled={op !== null || !newFormReady}
              onClick={doCreateSplit}
            >
              {op === "creating"
                ? "Saving..."
                : createIntent === "retail"
                  ? "Create and mark retail"
                  : createAndConfirm
                    ? "Create and confirm"
                    : "Create ingredient"}
            </button>
            <button
              type="button"
              className="kf-btn kf-btn--ghost kf-btn--sm"
              onClick={() => { setShowNew(false); setCreateIntent("confirm"); }}
              disabled={op !== null}
            >
              <XIcon size={14} strokeWidth={1.5} />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
