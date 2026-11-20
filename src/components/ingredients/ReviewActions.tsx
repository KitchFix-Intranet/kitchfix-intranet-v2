"use client";

// Stateless action bar for a review card. Selection state (which items
// are checked) lives in the parent ReviewCard - this component just
// receives the already-filtered checkedIds + a few summary fields and
// acts on them. The former "Pick individual items" expander is gone;
// every item row carries a visible checkbox now (ReviewCard owns the
// per-row rendering).

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check, X as XIcon, Ban, ShoppingBag, Archive, Loader2, Clock,
  AlertTriangle, Info, AlertOctagon,
} from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount, fmtUsd, fmtUsdLong } from "@/lib/fmt";
import {
  SUPER_CATEGORIES, categoryForParent, inferBaseUnit, type SuperCategory,
} from "@/lib/ingredients/categories";
import { uomLabel } from "@/lib/ingredients/pack";
import { canonicalIngredientName } from "@/lib/ingredients/nameNorm";
import { IngredientTypeahead, formatIngredientMeta } from "./IngredientTypeahead";
import { postJson, saveErrorSentence, undoViaEvent } from "./panel/common";
import { anyDirty, discardAll, DirtyScopeProvider, useDirtyEditor } from "./panel/dirty";

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
  // N10 §2c: raw pack_uom for inferBaseUnit() in the Costed-per
  // preview. The field exists on the ReviewGroupItem row already;
  // ReviewCard copies it onto the preview subset.
  packUom: string | null;
  usd12m: number;
};

// N10 R3: these fields are REQUIRED (not optional). §2b compares the
// typed name against the ingredients list the panel receives; §2a
// seeds Category + Sub-category from the card's own ingredient on a
// split; §2c's "retail ingredient" sentence reads `resale`. All three
// come free from ReviewQueue:169's existing SELECT.
type Ingredient = {
  id: string;
  name: string;
  parent: string | null;
  category: string | null;
  base_unit: string;
  resale: boolean;
};

type Props = {
  // T5b item 3: "notfood" variant draws two buttons only - "Yes, not
  // food" (markNotFood) and "It is food: pick an ingredient" (opens
  // the Relink panel). The exits group, New ingredient button and
  // the empty-selection line are suppressed. Decision functions
  // under src/lib/reviewWrites.ts do not change.
  kind: "existing" | "new" | "notfood";
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

// N10 R6: "relinkandconfirm" is a distinct op so the busy chrome
// lands on the Relink panel's primary, not on the bar's Confirm.
// T5b item 1: Keep separate and the card-level Flag left the card;
// "keepsep" and "flag" leave the union. Their routes stay.
type Op = null | "confirming" | "relinking" | "relinkandconfirm" | "creating" | "notfood" | "resale" | "archived" | "oneoff";

// T2 §1: ReviewActions now goes through the shared postJson in
// ./panel/common, so a dropped connection is a caught outcome and
// the three failure sentences come from one vocabulary. The local
// copy is retired; the toast / in-panel error paths below call
// saveErrorSentence(r) to produce the words.


// N4: Create-success toasts that name a master append the inferred
// unit when it is not the common-case default "each". Keeps the usual
// case (single-serve items, retail packaged goods) quiet and makes
// the inferred cases visible.
//
// N6: widened to every non-"each" base_unit (weight, volume, count).
// A null / missing value also prints nothing - callers that didn't
// thread baseUnit through don't accidentally show "undefined".
function unitSuffix(baseUnit: unknown): string {
  if (typeof baseUnit !== "string") return "";
  if (baseUnit === "" || baseUnit === "each") return "";
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
  // T2 round 2 §3-§4: each card has its own dirty-registry scope.
  // Relink + New-ingredient panels both live inside this card, so
  // they share the one scope. useId() gives us a React-stable string
  // across renders and between cards.
  const scopeBase = useId();
  const dirtyScope = `rvc-${scopeBase}`;
  // T5b item 2: the "Done" status chip + leaving-overlay sentence
  // are gone. One quiet signal: the card (or decided rows) leaves,
  // the Undo toast offers Undo. A failure still shows its sentence
  // in the card (bar + panel paths below).
  const [showRelink, setShowRelink] = useState(false);
  const [relinkId, setRelinkId] = useState<string | null>(null);
  // N10 round 2 fix 3: refocus the opener button when a panel closes
  // by any route (Esc, X, Cancel). The refs point at the bar buttons.
  const relinkOpenerRef = useRef<HTMLButtonElement>(null);
  const newOpenerRef = useRef<HTMLButtonElement>(null);
  const [newName, setNewName] = useState(proposedName ?? "");
  // N10 round 2 fix 2: starting values on a split (§2a). When the
  // card has an ingredient, Category + Sub-category seed from THAT
  // ingredient's own category + parent, not from the matcher's
  // proposed parent. New groups keep today's "proposed parent"
  // seed. A null category seeds blank.
  const splitSourceIng =
    kind === "existing" && currentIngredientId != null
      ? ingredients.find((i) => i.id === currentIngredientId) ?? null
      : null;
  const [newSuper, setNewSuper] = useState<SuperCategory | "">(() => {
    if (splitSourceIng) {
      return ((splitSourceIng.category as SuperCategory | null) ?? "") as SuperCategory | "";
    }
    return (categoryForParent(proposedParent) as SuperCategory | null) ?? "";
  });
  const [subMode, setSubMode] = useState<"pick" | "new">("pick");
  const [subPick, setSubPick] = useState<string>(
    splitSourceIng?.parent ?? proposedParent ?? ""
  );
  const [subNew, setSubNew] = useState<string>("");
  const [showNew, setShowNew] = useState(false);
  // N10 R4: createAndConfirm state is gone. The primary calls
  // doCreateSplit(true); the quiet link calls doCreateSplit(false);
  // the retail path calls doCreateSplit(true) with isRetail inferred
  // from createIntent. No stored flag that can drift.
  // N10 §2f: last-submit server error strings, cleared on next edit
  // or next submit. Renders the error band above the foot.
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);

  // T2 round 2 §3: the review-card panels register their drafts with
  // the card's dirty scope so Esc + the panel's Cancel ask "Discard
  // what you typed?" when anything has been typed. Discard resets
  // the fields and closes the panel.
  useDirtyEditor(
    "relink",
    showRelink && relinkId != null && op === null,
    () => {
      setRelinkId(null);
      setRelinkError(null);
      setShowRelink(false);
    },
    dirtyScope
  );
  const newInitialSuper: SuperCategory | "" = splitSourceIng
    ? (((splitSourceIng.category as SuperCategory | null) ?? "") as SuperCategory | "")
    : ((categoryForParent(proposedParent) as SuperCategory | null) ?? "");
  const newInitialSub = splitSourceIng?.parent ?? proposedParent ?? "";
  const newIsDirty =
    showNew && op === null && (
      newName.trim() !== (proposedName ?? "").trim() ||
      newSuper !== newInitialSuper ||
      subMode === "new" ||
      subPick !== newInitialSub ||
      subNew.trim().length > 0
    );
  useDirtyEditor(
    "new",
    newIsDirty,
    () => {
      setNewName(proposedName ?? "");
      setNewSuper(newInitialSuper);
      setSubMode("pick");
      setSubPick(newInitialSub);
      setSubNew("");
      setNewError(null);
      setShowNew(false);
    },
    dirtyScope
  );

  // T4 §6: the four "not for recipes" buttons report failure as a
  // sentence beside the buttons, not a toast. One state slot. T5b
  // item 1: the card-level Flag and Keep separate (and their note
  // form) are gone; row-level Flag + ledger-level Undo still cover
  // those paths.
  const [barError, setBarError] = useState<string | null>(null);
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

  // N10 §2b: client-side name-match detection via the same canonical
  // rule the server uses (reviewWrites.ts:739). Chat-Claude's
  // 2026-11-12 check on production: 0 rows where stored name_norm
  // differs from this rule, so the match here is byte-identical.
  const typedName = newName.trim();
  const typedNorm = typedName.length > 0 ? canonicalIngredientName(typedName) : "";
  const nameMatch: Ingredient | null = useMemo(() => {
    if (typedNorm === "") return null;
    for (const i of ingredients) {
      if (canonicalIngredientName(i.name) === typedNorm) return i;
    }
    return null;
  }, [ingredients, typedNorm]);
  const isSelfMatch =
    nameMatch != null && currentIngredientId != null && nameMatch.id === currentIngredientId;

  // Form is ready when the name is long enough AND either (a) the
  // typed name matches an existing active ingredient that is not this
  // card's own, or (b) the selects carry a super + a sub. On a match
  // the server ignores the form category anyway.
  const newFormReady =
    !isSelfMatch &&
    typedName.length >= 2 &&
    (nameMatch != null || (newSuper !== "" && effectiveSub.length > 0));

  // N10 §2c: unit under Costed per. inferBaseUnit() is the same
  // function the server calls (reviewWrites.ts:855), with the same
  // two inputs: the parent (our sub) and the items' raw pack_uom.
  const costedPerUnit = useMemo(() => {
    if (nameMatch) return nameMatch.base_unit;
    if (effectiveSub.length === 0) return null;
    return inferBaseUnit(effectiveSub || null, checkedItems.map((it) => it.packUom));
  }, [nameMatch, effectiveSub, checkedItems]);

  const cardTitle =
    kind === "existing"
      ? ingredients.find((i) => i.id === currentIngredientId)?.name ?? "this card"
      : proposedName ?? "this card";
  const cardHasIngredient = kind === "existing" && currentIngredientId != null;

  // Sum of checked items' 12-month spend - the {$} token in §2c.
  const checkedUsd = useMemo(
    () => checkedItems.reduce((s, it) => s + it.usd12m, 0),
    [checkedItems]
  );

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
      // T4 R2 §5: Confirm is a card button; sentence stays in the
      // card, no toast.
      setBarError("No ingredient target for this group");
      return;
    }
    setBarError(null);
    setOp("confirming");
    const r = await postJson("/api/review/confirm", {
      ingredientId: currentIngredientId,
      itemIds: checkedIds,
    });
    if (!r.ok) {
      // T4 R2 §5: card sentence, no toast.
      setBarError(saveErrorSentence(r) ?? "Nothing was saved.");
      setOp(null);
      return;
    }
    const d = r.data as { confirmed?: number; movedToResale?: number; event_id?: string | null };
    const confirmedIds = [...checkedIds];
    const movedToResale = d.movedToResale ?? 0;
    const base = `Confirmed ${fmtCount(d.confirmed ?? checkedCount)} items`;
    const undoEventId = d.event_id ?? null;
    toast(
      movedToResale > 0
        ? `${base} (${fmtCount(movedToResale)} landed as retail)`
        : base,
      {
        tone: "good",
        undo: undoEventId ? undoViaEvent(router, undoEventId) : undefined,
      }
    );
    setOp(null);
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

  // N10 §2e quiet link: today's behaviour. Items stay proposed on the
  // target's card.
  async function relinkChecked() {
    if (op || noneChecked || !relinkId) return;
    setRelinkError(null);
    setOp("relinking");
    let r: Awaited<ReturnType<typeof postJson>>;
    try {
      r = await postJson("/api/review/relink", {
        ingredientId: relinkId,
        itemIds: checkedIds,
      });
    } catch {
      // T4 §6: failed relink says it in the panel, not in a toast.
      setRelinkError("Could not reach the server. Nothing was sent.");
      setOp(null);
      return;
    }
    if (!r.ok) {
      setRelinkError(saveErrorSentence(r) ?? "Nothing was saved.");
      setOp(null);
      return;
    }
    // T3 §8: count actual changes, report both.
    const d = (r.data ?? {}) as { marked?: number; relinked?: number; skipped?: number; event_id?: string | null };
    const marked = Number(d.marked ?? d.relinked ?? 0);
    const skipped = Number(d.skipped ?? 0);
    const undoCb = d.event_id ? undoViaEvent(router, d.event_id) : undefined;
    if (marked === 0) {
      toast("Nothing changed - already decided");
    } else if (skipped > 0) {
      toast(`Relinked ${fmtCount(marked)} (${fmtCount(skipped)} already decided)`, { undo: undoCb });
    } else {
      toast(`Relinked ${fmtCount(marked)}`, { undo: undoCb });
    }
    setShowRelink(false);
    setOp(null);
    router.refresh();
  }

  // N10 §2e primary: Relink AND confirm in one step. Posts to the
  // EXISTING /api/review/confirm with the picked ingredient as the
  // target - confirmItems already sets ingredient_id, writes the
  // golden link and the learned alias, and cascades status='resale'
  // when the target is retail. No new route, no lib change.
  async function relinkAndConfirm() {
    if (op || noneChecked || !relinkId) return;
    setRelinkError(null);
    setOp("relinkandconfirm");
    let r: Awaited<ReturnType<typeof postJson>>;
    try {
      r = await postJson("/api/review/confirm", {
        ingredientId: relinkId,
        itemIds: checkedIds,
      });
    } catch {
      // T4 §6: failed relink says it in the panel, not in a toast.
      setRelinkError("Could not reach the server. Nothing was sent.");
      setOp(null);
      return;
    }
    if (!r.ok) {
      setRelinkError(saveErrorSentence(r) ?? "Nothing was saved.");
      setOp(null);
      return;
    }
    const d = (r.data ?? {}) as {
      confirmed?: number;
      movedToResale?: number;
      usd?: number;
      event_id?: string | null;
    };
    const target = ingredients.find((i) => i.id === relinkId);
    const targetName = target?.name ?? "the chosen ingredient";
    const movedRetail = Number(d.movedToResale ?? 0);
    const baseMsg = movedRetail > 0
      ? `Confirmed ${fmtCount(d.confirmed ?? checkedCount)} items on ${targetName}; ${fmtCount(movedRetail)} landed as retail`
      : `Confirmed ${fmtCount(d.confirmed ?? checkedCount)} items on ${targetName}`;
    toast(baseMsg, {
      undo: d.event_id ? undoViaEvent(router, d.event_id) : undefined,
    });
    setShowRelink(false);
    setRelinkId(null);
    setOp(null);
    if (onLeaveStart) {
      onLeaveStart(checkedIds);
    } else {
      router.refresh();
    }
  }

  // Split-to-new-ingredient. The chosen items get reassigned to the
  // new ingredient and stay link_status='proposed' so Kevin can see the
  // split in the queue under the new ingredient's own card. Confirm is
  // a separate step on that new card (fixes the "the one I moved
  // disappeared" / "still falls under the group I removed it from"
  // complaints).
  // N10 R4: confirmArg replaces the createAndConfirm state. Primary
  // calls doCreateSplit(true); quiet link calls doCreateSplit(false);
  // retail intent forces true regardless (existing N3 contract). No
  // stored flag.
  async function doCreateSplit(confirmArg: boolean) {
    if (op || noneChecked) return;
    const name = newName.trim();
    // §2f: pre-submit validation toasts removed. The disabled primary
    // + the "What happens" line 2 already say what is missing.
    if (!newFormReady) return;
    setNewError(null);
    setOp("creating");
    const isRetail = createIntent === "retail";
    // N10 round 2 fix 6: on a name match send the EXISTING
    // ingredient's parent + category. If the client's list is stale
    // and the server doesn't actually find the match, the
    // create-side path still has the real values, not null + null -
    // which would create an ingredient with no category, the thing
    // the required fields exist to prevent. Payload is byte-
    // identical on the no-match path.
    const payloadParent = nameMatch ? (nameMatch.parent ?? null) : (effectiveSub || null);
    const payloadCategory = nameMatch ? (nameMatch.category ?? null) : (newSuper || null);
    // N10 round 2 fix 10: panel submits catch network throws so a
    // dropped connection does not leave the panel on "Saving..."
    // forever. Other handlers are untouched.
    let r: Awaited<ReturnType<typeof postJson>>;
    try {
      r = await postJson("/api/review/new-ingredient", {
      name,
      parent: payloadParent,
      category: payloadCategory,
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
      confirm: isRetail ? true : confirmArg,
      resale: isRetail,
    });
    } catch {
      // T4 R2 §5: New ingredient failure stays in the panel, not a toast.
      setNewError("Could not reach the server. Nothing was sent.");
      setOp(null);
      return;
    }
    if (!r.ok) {
      setNewError(saveErrorSentence(r) ?? "Nothing was saved.");
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
      event_id?: string | null;
    };
    const moved = d.moved ?? checkedCount;
    const unit = unitSuffix(d.baseUnit);
    const isJoin = nameMatch != null;
    // T4 R2: every Create success carries an Undo. The server
    // returned the primary event id; undoViaEvent rolls the whole
    // click back (split + confirm, or split + retail) as one.
    const undoCb = d.event_id ? undoViaEvent(router, d.event_id) : undefined;
    if (isRetail) {
      const n = d.marked ?? d.confirmed ?? moved;
      toast(
        isJoin
          ? `Added ${fmtCount(n)} items to "${nameMatch!.name}" and marked as retail`
          : `Created "${name}"${unit} and marked ${fmtCount(n)} item${n === 1 ? "" : "s"} as retail`,
        { undo: undoCb },
      );
    } else if (confirmArg) {
      const confirmed = d.confirmed ?? moved;
      toast(
        isJoin
          ? `Added ${fmtCount(confirmed)} items to "${nameMatch!.name}" and confirmed`
          : `Created "${name}"${unit} and confirmed ${fmtCount(confirmed)} item${confirmed === 1 ? "" : "s"}`,
        { undo: undoCb },
      );
    } else {
      toast(
        isJoin
          ? `Added ${fmtCount(moved)} items to "${nameMatch!.name}" - confirm them on its card.`
          : `Created "${name}"${unit} - ${fmtCount(moved)} items moved; confirm them on the new card.`,
        { undo: undoCb },
      );
    }
    setShowNew(false);
    setCreateIntent("confirm");
    setOp(null);
    // Create flows keep today's refresh path (router.refresh). The
    // leaving animation is only wired on relink+confirm per §2e.
    router.refresh();
  }

  async function markNotFood() {
    if (op || noneChecked) return;
    setBarError(null);
    setOp("notfood");
    const r = await postJson("/api/review/not-food", { itemIds: checkedIds });
    if (!r.ok) {
      // T4 §6: sentence stays in the card. No toast.
      setBarError(saveErrorSentence(r) ?? "Nothing was saved.");
      setOp(null);
      return;
    }
    const d = (r.data ?? {}) as { marked?: number; skipped?: number; event_id?: string | null };
    const marked = Number(d.marked ?? 0);
    const skipped = Number(d.skipped ?? 0);
    const undoCb = d.event_id ? undoViaEvent(router, d.event_id) : undefined;
    if (marked === 0) {
      toast("Nothing changed - already decided");
    } else if (skipped > 0) {
      toast(`Marked ${fmtCount(marked)} as not food (${fmtCount(skipped)} already decided)`, { undo: undoCb });
    } else {
      toast(`Marked ${fmtCount(marked)} as not food`, { undo: undoCb });
    }
    setOp(null);
    // T5b item 2: every exit plays the leave animation (one quiet
    // signal), then router.refresh() from the parent. Same path the
    // Confirm button has had since T4.
    if (onLeaveStart) {
      onLeaveStart(checkedIds);
    } else {
      router.refresh();
    }
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
    setBarError(null);
    setOp("oneoff");
    const r = await postJson("/api/review/one-off", { itemIds: checkedIds });
    if (!r.ok) {
      // T4 §6: sentence stays in the card. No toast.
      setBarError(saveErrorSentence(r) ?? "Nothing was saved.");
      setOp(null);
      return;
    }
    const d = (r.data ?? {}) as { marked?: number; skipped?: number; event_id?: string | null };
    const marked = Number(d.marked ?? 0);
    const skipped = Number(d.skipped ?? 0);
    const undoCb = d.event_id ? undoViaEvent(router, d.event_id) : undefined;
    if (marked === 0) {
      toast("Nothing changed - already decided");
    } else if (skipped > 0) {
      toast(`Marked ${fmtCount(marked)} as one-off purchase${marked === 1 ? "" : "s"} (${fmtCount(skipped)} already decided)`, { undo: undoCb });
    } else {
      toast(`Marked ${fmtCount(marked)} as one-off purchase${marked === 1 ? "" : "s"}`, { undo: undoCb });
    }
    setOp(null);
    if (onLeaveStart) {
      onLeaveStart(checkedIds);
    } else {
      router.refresh();
    }
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
        // T4 §6: sentence stays in the card.
        setBarError(saveErrorSentence(r) ?? "Nothing was saved.");
        setOp(null);
        return;
      }
      const d = r.data as { confirmed?: number; marked?: number; baseUnit?: string; event_id?: string | null };
      const n = d.marked ?? d.confirmed ?? checkedCount;
      // T4 R2: toast carries Undo, like every other decision.
      toast(
        `Created "${name}"${unitSuffix(d.baseUnit)} and marked ${fmtCount(n)} item${n === 1 ? "" : "s"} as retail`,
        {
          tone: "good",
          undo: d.event_id ? undoViaEvent(router, d.event_id) : undefined,
        }
      );
      setOp(null);
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
      setBarError("No ingredient target for this group");
      return;
    }
    setBarError(null);
    setOp("resale");
    const r = await postJson("/api/review/resale", {
      ingredientId: currentIngredientId,
      itemIds: checkedIds,
    });
    if (!r.ok) {
      // T4 §6: sentence stays in the card.
      setBarError(saveErrorSentence(r) ?? "Nothing was saved.");
      setOp(null);
      return;
    }
    const d = r.data as { confirmed?: number; marked?: number; ingredientIsRetail?: boolean; event_id?: string | null };
    const n = d.marked ?? d.confirmed ?? checkedCount;
    const msg = d.ingredientIsRetail
      ? `Marked ${fmtCount(n)} as retail`
      : `Marked ${fmtCount(n)} as retail - the ingredient is still a recipe ingredient. Flip its Retail toggle in the detail panel to move the whole ingredient.`;
    toast(msg, {
      tone: "good",
      undo: d.event_id ? undoViaEvent(router, d.event_id) : undefined,
    });
    setOp(null);
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
    setBarError(null);
    setOp("archived");
    const r = await postJson("/api/review/archive", { itemIds: checkedIds });
    if (!r.ok) {
      // T4 §6: sentence stays in the card.
      setBarError(saveErrorSentence(r) ?? "Nothing was saved.");
      setOp(null);
      return;
    }
    const d = (r.data ?? {}) as { marked?: number; skipped?: number; event_id?: string | null };
    const marked = Number(d.marked ?? 0);
    const skipped = Number(d.skipped ?? 0);
    const undoCb = d.event_id ? undoViaEvent(router, d.event_id) : undefined;
    if (marked === 0) {
      toast("Nothing changed - already decided");
    } else if (skipped > 0) {
      toast(`Archived ${fmtCount(marked)} item${marked === 1 ? "" : "s"} (${fmtCount(skipped)} already decided)`, { undo: undoCb });
    } else {
      toast(`Archived ${fmtCount(marked)} item${marked === 1 ? "" : "s"}`, { undo: undoCb });
    }
    setOp(null);
    if (onLeaveStart) {
      onLeaveStart(checkedIds);
    } else {
      router.refresh();
    }
  }

  // T5b item 1: the card-level Flag's note form and keepSeparate are
  // retired. Routes still answer (row-level flag toggle still posts to
  // /api/review/flag; Keep separate decisions already in Recent
  // decisions can still be undone from there).

  return (
    <div className="kf-rvc__actions">
      {/* N9 §2d: three button groups on one row. Groups 1 and 2 lose
          their icons; group 3 keeps them. The selected count is NOT
          here - it lives in the head (§2a), once. */}
      <div className="kf-rvc__actions-row">
        {/* T5b item 1 + item 3: the lead button is the only filled
            button on a card. When a panel is open the lead draws
            as a line button (reference vCard rule). The notfood
            variant's lead calls markNotFood directly - the "Yes,
            not food" text is its own, and the busy label is the
            shared "Saving..." phrase. */}
        <button
          type="button"
          className={`kf-btn ${showRelink || showNew ? "kf-btn--line" : "kf-btn--primary"} kf-btn--sm${op === "confirming" || op === "notfood" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={kind === "notfood" ? markNotFood : confirmChecked}
        >
          {kind === "notfood"
            ? (op === "notfood" ? "Saving..." : "Yes, not food")
            : op === "confirming"
              ? "Saving..."
              : kind === "new"
                ? "Create ingredient"
                : ingredientResale
                  ? "Confirm as retail"
                  : "Confirm"}
        </button>

        {/* N10 §2a: opening one panel closes the other.
            aria-pressed="true" renders the button filled while open. */}
        <button
          ref={relinkOpenerRef}
          type="button"
          className={`kf-btn kf-btn--line kf-btn--sm${showRelink ? " is-on" : ""}`}
          aria-pressed={showRelink}
          disabled={op !== null || noneChecked}
          onClick={() => {
            const next = !showRelink;
            setShowRelink(next);
            if (next) {
              setShowNew(false);
              setRelinkError(null);
            }
          }}
        >
          {kind === "notfood" ? "It is food: pick an ingredient" : "Relink"}
        </button>

        {kind === "existing" ? (
          <button
            ref={newOpenerRef}
            type="button"
            className={`kf-btn kf-btn--line kf-btn--sm${showNew ? " is-on" : ""}`}
            aria-pressed={showNew}
            disabled={op !== null || noneChecked}
            onClick={() => {
              const next = !showNew;
              setShowNew(next);
              if (next) {
                setShowRelink(false);
                setNewError(null);
              }
            }}
          >
            New ingredient
          </button>
        ) : null}

        {/* T5b item 1: Keep separate and the card-level Flag are off
            the card. Their routes stay; the row-level flag toggle
            and existing Keep separate decisions in Recent decisions
            can still be undone. */}

        {/* T5b item 1: the four exits as one labelled group. Icons
            keep the eye sorting. Order follows the reference's
            vCard(): Retail, One-off, Archive, Not food.
            T5b item 3: the notfood card has two buttons total (the
            lead above + Relink). The exits group is suppressed. */}
        {kind === "notfood" ? null : (
        <span
          className="kf-rvc__exits"
          role="group"
          aria-label="Not for recipes"
        >
          <span className="kf-rvc__exits-kicker" aria-hidden>Not for recipes</span>
          <button
            type="button"
            className={`kf-btn kf-btn--soft kf-btn--sm${op === "resale" ? " is-busy" : ""}`}
            disabled={op !== null || noneChecked}
            onClick={markResale}
            title="Sold as-is to players (water, snacks, sandwiches); tracked as retail spend, not a recipe ingredient"
          >
            <ShoppingBag size={14} strokeWidth={1.5} aria-hidden />
            <span>{op === "resale" ? "Saving..." : "Retail"}</span>
          </button>

          <button
            type="button"
            className={`kf-btn kf-btn--soft kf-btn--sm${op === "oneoff" ? " is-busy" : ""}`}
            disabled={op !== null || noneChecked}
            onClick={markOneOff}
            title="Real food bought once that doesn't deserve a master (parked, not tracked in recipe coverage or retail)"
          >
            <Clock size={14} strokeWidth={1.5} aria-hidden />
            <span>{op === "oneoff" ? "Saving..." : "One-off"}</span>
          </button>

          <button
            type="button"
            className={`kf-btn kf-btn--soft kf-btn--sm${op === "archived" ? " is-busy" : ""}`}
            disabled={op !== null || noneChecked}
            onClick={markArchived}
            title="Mistake or dead item; parked and not tracked in recipe coverage or retail"
          >
            <Archive size={14} strokeWidth={1.5} aria-hidden />
            <span>{op === "archived" ? "Saving..." : "Archive"}</span>
          </button>

          <button
            type="button"
            className={`kf-btn kf-btn--soft kf-btn--sm${op === "notfood" ? " is-busy" : ""}`}
            disabled={op !== null || noneChecked}
            onClick={markNotFood}
            title="Not a consumable product (fees, freight, supplies)"
          >
            <Ban size={14} strokeWidth={1.5} aria-hidden />
            <span>{op === "notfood" ? "Saving..." : "Not food"}</span>
          </button>
        </span>
        )}

        {op !== null ? (
          <span className="kf-rvc__actions-status kf-rvc__actions-status--busy" aria-live="polite">
            <Loader2 size={12} strokeWidth={2.5} className="kf-rvc__spin" aria-hidden />
            Saving...
          </span>
        ) : barError ? (
          // T4 §6: the sentence sits beside the buttons until the
          // next press. No toast fires. Any of the bar handlers
          // clears this at the top of its call.
          <span className="kf-dpn__flash kf-dpn__flash--err" role="alert">
            {barError}
          </span>
        ) : null}
      </div>

      {/* T5b item 1 + item 3: with nothing ticked the card says so
          in one line below the action bar. The old legend + "moves
          to Linked" footer is retired; the four exits are explained
          once above the list, in a .kf-helpline above the first
          card (see ReviewFilter). The notfood variant adds the
          reference's standing sentence. */}
      {kind === "notfood" ? (
        <p className="kf-rvc__help">
          {noneChecked ? "Select an item to decide it. " : ""}
          The matcher read these as fees, freight or supplies, so it
          suggested no ingredient. Say yes and they leave food spend.
        </p>
      ) : noneChecked ? (
        <p className="kf-rvc__help">Select an item to decide it.</p>
      ) : null}

      {showRelink ? (
        <RelinkPanel
          ingredients={ingredients}
          currentIngredientId={currentIngredientId}
          pickedId={relinkId}
          onPick={(id) => { setRelinkId(id); setRelinkError(null); }}
          cardTitle={cardTitle}
          cardHasIngredient={cardHasIngredient}
          checkedCount={checkedCount}
          memberCount={memberCount}
          checkedUsd={checkedUsd}
          checkedItems={checkedItems}
          op={op}
          error={relinkError}
          onClose={() => {
            setShowRelink(false);
            setRelinkError(null);
            // N10 round 2 fix 3: focus returns to the opener.
            relinkOpenerRef.current?.focus();
          }}
          onPrimary={relinkAndConfirm}
          onQuietLink={relinkChecked}
          scope={dirtyScope}
        />
      ) : null}

      {showNew ? (
        <NewIngredientPanel
          intent={createIntent}
          newName={newName}
          onNameChange={(v) => { setNewName(v); setNewError(null); }}
          newSuper={newSuper}
          onSuperChange={(v) => { setNewSuper(v); setNewError(null); }}
          subMode={subMode}
          onSubModeToggle={() => setSubMode((m) => (m === "pick" ? "new" : "pick"))}
          subPick={subPick}
          onSubPick={(v) => { setSubPick(v); setNewError(null); }}
          subNew={subNew}
          onSubNewChange={(v) => { setSubNew(v); setNewError(null); }}
          parentOptions={parentOptions}
          cardTitle={cardTitle}
          cardHasIngredient={cardHasIngredient}
          cardIngredient={ingredients.find((i) => i.id === currentIngredientId) ?? null}
          checkedCount={checkedCount}
          memberCount={memberCount}
          checkedUsd={checkedUsd}
          checkedItems={checkedItems}
          nameMatch={nameMatch}
          isSelfMatch={isSelfMatch}
          effectiveSub={effectiveSub}
          newFormReady={newFormReady}
          costedPerUnit={costedPerUnit}
          op={op}
          error={newError}
          onClose={() => {
            setShowNew(false);
            setCreateIntent("confirm");
            setNewError(null);
            // N10 round 2 fix 3: focus returns to the opener.
            newOpenerRef.current?.focus();
          }}
          onPrimary={() => doCreateSplit(true)}
          onQuietLink={() => doCreateSplit(false)}
          scope={dirtyScope}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// N10: review-card panel primitives.
// ---------------------------------------------------------------------------

// N10 §2 panel shell. Head (title + optional Retail pill + 44 px close),
// 2 px navy rule, two-column body, optional error band, foot with
// quiet link + Cancel + primary. Escape bails when
// event.defaultPrevented so the typeahead's own Escape handler wins
// while its list is open (R1).
function ReviewCardPanelShell({
  title,
  retailPill = false,
  body,
  error,
  foot,
  onClose,
  busy,
  scope,
}: {
  title: string;
  retailPill?: boolean;
  body: React.ReactNode;
  error: string | null;
  // T2 round 2 §3: foot is a render prop so the shell can hand its
  // own tryClose to every Cancel button. Callers that do not need it
  // can ignore the argument.
  foot: (tryClose: () => void) => React.ReactNode;
  onClose: () => void;
  busy: boolean;
  // T2 round 2 §3-§4: the scope this panel's typed fields register
  // under. tryClose checks anyDirty(scope); Discard calls
  // discardAll(scope).
  scope: string;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const tryClose = () => {
    if (anyDirty(scope)) {
      setAskOpen(true);
      return;
    }
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return; // R1: typeahead already handled it
      if (busy) return;
      e.preventDefault();
      tryClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // tryClose closes over scope + onClose + busy; re-register when any change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, busy, scope]);
  useEffect(() => {
    if (askOpen) keepRef.current?.focus();
  }, [askOpen]);

  return (
    <div className="kf-rvc__panel" role="group" aria-label={title}>
      <div className="kf-rvc__panel-head">
        <h4 className="kf-rvc__panel-head-title">{title}</h4>
        {retailPill ? <span className="kf-pill kf-pill--muted">Retail</span> : null}
        <button
          type="button"
          className="kf-rvc__panel-close"
          onClick={tryClose}
          disabled={busy}
          aria-label="Close panel"
        >
          <XIcon size={18} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
      <DirtyScopeProvider scope={scope}>
        <div className="kf-rvc__panel-body">{body}</div>
      </DirtyScopeProvider>
      {error ? (
        <div className="kf-rvc__panel-err" role="alert">
          <AlertOctagon size={18} strokeWidth={1.75} aria-hidden />
          <span>
            <b>That did not finish.</b> {error}
          </span>
        </div>
      ) : null}
      <div className="kf-rvc__panel-foot">{foot(tryClose)}</div>
      {askOpen ? (
        <div className="kf-rvc__panel-ask" role="alertdialog" aria-modal="true">
          <h5>Discard what you typed?</h5>
          <p>Your changes have not been saved.</p>
          <div className="kf-rvc__panel-ask-actions">
            <button
              ref={keepRef}
              type="button"
              className="kf-btn kf-btn--primary kf-btn--sm"
              onClick={() => setAskOpen(false)}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="kf-btn kf-btn--line kf-btn--sm"
              onClick={() => {
                discardAll(scope);
                setAskOpen(false);
                onClose();
              }}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// N10 §2c "What happens" box - pure function + renderer. Dollars via
// fmtUsdLong per §2c.
type WhatHappensInput = {
  mode: "new" | "relink";
  cardTitle: string;
  cardHasIngredient: boolean;
  checkedCount: number;
  memberCount: number;
  checkedUsd: number;
  // new
  name?: string;
  category?: string | null;
  sub?: string | null;
  nameMatch?: Ingredient | null;
  isSelfMatch?: boolean;
  intent?: "confirm" | "retail";
  costedPerUnit?: string | null;
  // relink
  pickedTarget?: Ingredient | null;
};
type WhatHappens = {
  line1: React.ReactNode;
  line2: string;
};

export function computeWhatHappens(x: WhatHappensInput): WhatHappens {
  const n = x.checkedCount;
  const nWord = n === 1 ? "item" : "items";
  const otherM = x.memberCount - x.checkedCount;
  const otherSuffix =
    otherM > 0 ? ` The other ${otherM} ${otherM === 1 ? "stays" : "stay"} on this card.` : "";
  const dollars = fmtUsdLong(x.checkedUsd);
  const wholeGroup = x.checkedCount === x.memberCount;

  // Opening phrase for counts + spend. "All {n} items, worth {$} a
  // year, ..." on whole-group selections; "{n} items worth {$} a
  // year" on subsets.
  const openStrong = wholeGroup ? `All ${fmtCount(n)} ${nWord}` : `${fmtCount(n)} ${nWord}`;
  const openCountBold = <b>{openStrong}</b>;
  const openUsdBold = <b>{dollars}</b>;

  if (x.mode === "relink") {
    const target = x.pickedTarget;
    if (!target) {
      // Relink, nothing picked.
      const line1 = x.cardHasIngredient ? (
        <>{openCountBold} worth {openUsdBold} a year leave {x.cardTitle}.</>
      ) : (
        <>{openCountBold} worth {openUsdBold} a year.</>
      );
      return {
        line1,
        line2: `Pick the ingredient they belong to.${otherSuffix}`,
      };
    }
    const line1 = x.cardHasIngredient ? (
      <>{openCountBold} worth {openUsdBold} a year move from {x.cardTitle} to <b>{target.name}</b>.</>
    ) : (
      <>{openCountBold} worth {openUsdBold} a year move to <b>{target.name}</b>.</>
    );
    const line2 = target.resale
      ? `${target.name} is a retail ingredient, so they land as retail and leave the queue.${otherSuffix}`
      : `They are confirmed on it and leave the queue.${otherSuffix}`;
    return { line1, line2 };
  }

  // mode === "new"
  const name = (x.name ?? "").trim();
  const category = x.category ?? null;
  const sub = x.sub ?? null;
  const intent = x.intent ?? "confirm";
  const nameMatch = x.nameMatch ?? null;
  const isSelfMatch = x.isSelfMatch ?? false;

  // Line 1 variants.
  let line1: React.ReactNode;
  if (isSelfMatch && nameMatch) {
    // N10 round 2 fix 7: own-card match. Line 1 is a plain
    // statement; Costed per is hidden in this state by the caller.
    line1 = (
      <>{openCountBold} worth {openUsdBold} a year are already on {x.cardTitle}.</>
    );
  } else if (nameMatch) {
    line1 = x.cardHasIngredient ? (
      <>{openCountBold} worth {openUsdBold} a year leave {x.cardTitle} and join <b>{nameMatch.name}</b>, which already exists.</>
    ) : (
      <>{openCountBold} worth {openUsdBold} a year join <b>{nameMatch.name}</b>, which already exists.</>
    );
  } else {
    const becomePrefix = x.cardHasIngredient
      ? (<>{openCountBold} worth {openUsdBold} a year leave {x.cardTitle} and become </>)
      : (wholeGroup
          ? (<>{openCountBold}, worth {openUsdBold} a year, become </>)
          : (<>{openCountBold} worth {openUsdBold} a year become </>));
    const becomeBody = name.length === 0
      ? <>a new ingredient</>
      : (category && sub)
        ? <><b>{name}</b> in {category} &middot; {sub}</>
        : <><b>{name}</b></>;
    line1 = <>{becomePrefix}{becomeBody}.</>;
  }

  // Line 2.
  let line2 = "";
  if (isSelfMatch && nameMatch) {
    line2 = `This card is already ${nameMatch.name}. Use Confirm instead.`;
  } else if (!nameMatch && name.length === 0) {
    line2 = `Give it a name to continue.${otherSuffix}`;
  } else if (!nameMatch && !category) {
    line2 = `Pick a category to continue.${otherSuffix}`;
  } else if (!nameMatch && !sub) {
    line2 = `Pick or type a sub-category to continue.${otherSuffix}`;
  } else if (intent === "retail") {
    line2 = `They are marked retail and leave the queue. Retail items are sold as-is and stay out of recipes.${otherSuffix}`;
  } else {
    line2 = `They are confirmed on it and leave the queue.${otherSuffix}`;
  }
  return { line1, line2 };
}

function WhatHappensBox({
  wh,
  checkedItems,
  memberCount,
  costedPer,
}: {
  wh: WhatHappens;
  checkedItems: NewIngredientPreviewItem[];
  memberCount: number;
  costedPer: { unit: string; reason: string } | null;
}) {
  const wholeGroup = checkedItems.length === memberCount;
  const listShown = !wholeGroup && checkedItems.length > 0;
  const shown = listShown ? checkedItems.slice(0, 5) : [];
  const overflow = listShown ? Math.max(0, checkedItems.length - 5) : 0;
  return (
    <aside className="kf-rvc__panel-what">
      <div className="kf-rvc__panel-what-label">What happens</div>
      <p className="kf-rvc__panel-what-l1">{wh.line1}</p>
      <p className="kf-rvc__panel-what-l2">{wh.line2}</p>
      {listShown ? (
        <ul className="kf-rvc__panel-what-list">
          {shown.map((it) => (
            <li key={it.id}>
              <span className="kf-rvc__panel-what-item">{it.displayName}</span>
              <span className="kf-rvc__panel-what-vendor">{it.vendor}</span>
              <b className="kf-rvc__panel-what-usd">{fmtUsdLong(it.usd12m)}</b>
            </li>
          ))}
          {overflow > 0 ? (
            <li className="kf-rvc__panel-what-more">+ {overflow} more</li>
          ) : null}
        </ul>
      ) : null}
      {costedPer ? (
        <div className="kf-rvc__panel-what-kv">
          <span className="kf-rvc__panel-what-kv-k">Costed per</span>
          <b>{uomLabel(costedPer.unit)}</b>
          <span className="kf-rvc__panel-what-kv-r">{costedPer.reason}</span>
        </div>
      ) : null}
    </aside>
  );
}

// N10 §2e Relink panel.
function RelinkPanel({
  ingredients,
  currentIngredientId,
  pickedId,
  onPick,
  cardTitle,
  cardHasIngredient,
  checkedCount,
  memberCount,
  checkedUsd,
  checkedItems,
  op,
  error,
  onClose,
  onPrimary,
  onQuietLink,
  scope,
}: {
  ingredients: Ingredient[];
  currentIngredientId: string | null;
  pickedId: string | null;
  onPick: (id: string | null) => void;
  cardTitle: string;
  cardHasIngredient: boolean;
  checkedCount: number;
  memberCount: number;
  checkedUsd: number;
  checkedItems: NewIngredientPreviewItem[];
  op: Op;
  error: string | null;
  onClose: () => void;
  onPrimary: () => void;
  onQuietLink: () => void;
  scope: string;
}) {
  const picked = pickedId ? ingredients.find((i) => i.id === pickedId) ?? null : null;
  // N10 round 2 fix 4: when Change clears the pick, the typeahead
  // remounts with the previous name pre-filled + selected.
  const [prevPickedName, setPrevPickedName] = useState<string>("");
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const wh = computeWhatHappens({
    mode: "relink",
    cardTitle,
    cardHasIngredient,
    checkedCount,
    memberCount,
    checkedUsd,
    pickedTarget: picked,
  });
  const busy = op !== null;
  const ready = picked != null && !busy;
  // N10 round 2 fix 3: once a result is picked, focus the primary so
  // a second Enter submits.
  useEffect(() => {
    if (picked) primaryBtnRef.current?.focus();
  }, [picked]);
  return (
    <ReviewCardPanelShell
      title="Relink"
      body={
        <>
          <div className="kf-rvc__panel-form">
            {picked ? (
              <div>
                <label className="kf-ipanel__editor-field">Move to</label>
                <div className="kf-rvc__panel-picked">
                  <div>
                    <b>{picked.name}</b>
                    {formatIngredientMeta(picked) ? (
                      <div className="kf-ingtype__meta">{formatIngredientMeta(picked)}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="kf-btn kf-btn--line kf-btn--sm"
                    onClick={() => {
                      // N10 round 2 fix 4: stash the current pick's
                      // name so the typeahead's next mount pre-fills
                      // it + autofocuses + selects the text.
                      setPrevPickedName(picked.name);
                      onPick(null);
                    }}
                    disabled={busy}
                  >
                    Change
                  </button>
                </div>
              </div>
            ) : (
              <IngredientTypeahead
                ingredients={ingredients}
                excludeId={currentIngredientId ?? undefined}
                label="Move to"
                placeholder="Type to search ingredients..."
                pickedId={null}
                onPick={(id) => onPick(id)}
                busy={busy}
                showResultMeta
                // N10 round 2 fix 3: panel opens with focus in the
                // search, not on the Relink bar button.
                autoFocusInput
                // N10 round 2 fix 4: Change returns with the name
                // pre-filled + selected.
                initialQuery={prevPickedName}
                selectOnFocus={prevPickedName.length > 0}
              />
            )}
          </div>
          <WhatHappensBox
            wh={wh}
            checkedItems={checkedItems}
            memberCount={memberCount}
            costedPer={null}
          />
        </>
      }
      error={error}
      scope={scope}
      foot={(tryClose) => (
        <>
          <button
            type="button"
            className="kf-rvc__panel-link"
            onClick={onQuietLink}
            disabled={!ready}
          >
            Relink without confirming
          </button>
          <button
            type="button"
            className="kf-btn kf-btn--ghost kf-btn--sm"
            onClick={tryClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            ref={primaryBtnRef}
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${op === "relinkandconfirm" ? " is-busy" : ""}`}
            onClick={onPrimary}
            disabled={!ready}
          >
            {op === "relinkandconfirm"
              ? "Saving..."
              : `Relink and confirm ${fmtCount(checkedCount)} item${checkedCount === 1 ? "" : "s"}`}
          </button>
        </>
      )}
      onClose={onClose}
      busy={busy}
    />
  );
}

// N10 §2a + §2b + §2c + §2d New ingredient panel.
function NewIngredientPanel({
  intent,
  newName,
  onNameChange,
  newSuper,
  onSuperChange,
  subMode,
  onSubModeToggle,
  subPick,
  onSubPick,
  subNew,
  onSubNewChange,
  parentOptions,
  cardTitle,
  cardHasIngredient,
  cardIngredient,
  checkedCount,
  memberCount,
  checkedUsd,
  checkedItems,
  nameMatch,
  isSelfMatch,
  effectiveSub,
  newFormReady,
  costedPerUnit,
  op,
  error,
  onClose,
  onPrimary,
  onQuietLink,
  scope,
}: {
  intent: "confirm" | "retail";
  newName: string;
  onNameChange: (v: string) => void;
  newSuper: SuperCategory | "";
  onSuperChange: (v: SuperCategory | "") => void;
  subMode: "pick" | "new";
  onSubModeToggle: () => void;
  subPick: string;
  onSubPick: (v: string) => void;
  subNew: string;
  onSubNewChange: (v: string) => void;
  parentOptions: string[];
  cardTitle: string;
  cardHasIngredient: boolean;
  cardIngredient: Ingredient | null;
  checkedCount: number;
  memberCount: number;
  checkedUsd: number;
  checkedItems: NewIngredientPreviewItem[];
  nameMatch: Ingredient | null;
  isSelfMatch: boolean;
  effectiveSub: string;
  newFormReady: boolean;
  costedPerUnit: string | null;
  op: Op;
  error: string | null;
  onClose: () => void;
  onPrimary: () => void;
  onQuietLink: () => void;
  scope: string;
}) {
  const busy = op !== null;
  const matchDisabled = nameMatch != null;
  const n = fmtCount(checkedCount);
  const itemsWord = checkedCount === 1 ? "item" : "items";
  const seedFromCard = cardHasIngredient && cardIngredient;
  const seededCategory =
    seedFromCard && cardIngredient!.category && newSuper === cardIngredient!.category;
  const seededSub =
    seedFromCard && cardIngredient!.parent && subMode === "pick" && subPick === cardIngredient!.parent;

  const wh = computeWhatHappens({
    mode: "new",
    cardTitle,
    cardHasIngredient,
    checkedCount,
    memberCount,
    checkedUsd,
    name: newName,
    category: newSuper || null,
    sub: effectiveSub || null,
    nameMatch,
    isSelfMatch,
    intent,
  });

  const costedPer = (() => {
    // N10 round 2 fix 7: own-card match hides Costed per - the row
    // is already on this ingredient, there is nothing to decide.
    if (isSelfMatch) return null;
    if (nameMatch) {
      return {
        unit: nameMatch.base_unit,
        reason: `· already set on ${nameMatch.name}`,
      };
    }
    if (effectiveSub.length > 0 && costedPerUnit) {
      return {
        unit: costedPerUnit,
        reason: "· from the pack sizes on these items",
      };
    }
    return null;
  })();

  const primaryLabel = (() => {
    if (busy && op === "creating") return "Saving...";
    if (intent === "retail") {
      return matchDisabled
        ? `Join and mark ${n} ${itemsWord} retail`
        : `Create and mark ${n} ${itemsWord} retail`;
    }
    return matchDisabled
      ? `Join and confirm ${n} ${itemsWord}`
      : `Create and confirm ${n} ${itemsWord}`;
  })();

  const linkLabel = matchDisabled ? "Join without confirming" : "Create without confirming";

  // Enter in Name or in subNew submits the primary when ready.
  function onFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter") return;
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag !== "INPUT") return;
    if (!newFormReady || busy) return;
    e.preventDefault();
    onPrimary();
  }

  return (
    <ReviewCardPanelShell
      title="New ingredient"
      retailPill={intent === "retail"}
      body={
        <>
          <form
            className="kf-rvc__panel-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (newFormReady && !busy) onPrimary();
            }}
            onKeyDown={onFormKeyDown}
          >
            {isSelfMatch && nameMatch ? (
              <div className="kf-rvc__panel-note kf-rvc__panel-note--warn" role="alert">
                <AlertTriangle size={18} strokeWidth={1.75} aria-hidden />
                <span>This card is already <b>{nameMatch.name}</b>. Use Confirm instead.</span>
              </div>
            ) : null}
            <label className="kf-ipanel__editor-field">
              Name
              <input
                type="text"
                className="kf-ctl"
                value={newName}
                onChange={(e) => onNameChange(e.target.value)}
                autoFocus
                disabled={busy}
              />
            </label>
            {nameMatch && !isSelfMatch ? (
              <div className="kf-rvc__panel-note kf-rvc__panel-note--info">
                <Info size={18} strokeWidth={1.75} aria-hidden />
                <span>
                  <b>{nameMatch.name}</b> already exists. These items will join it instead of creating a duplicate.
                </span>
              </div>
            ) : null}
            <div className="kf-rvc__panel-form-grid2">
              <label className="kf-ipanel__editor-field">
                <span>
                  Category
                  {!nameMatch && seededCategory && cardIngredient ? (
                    <span className="kf-rvc__panel-from"> · from {cardIngredient.name}</span>
                  ) : null}
                  {matchDisabled && nameMatch ? (
                    <span className="kf-rvc__panel-from"> · set on {nameMatch.name}</span>
                  ) : null}
                </span>
                <select
                  className="kf-ctl"
                  value={matchDisabled && nameMatch ? (nameMatch.category ?? "") : newSuper}
                  onChange={(e) => onSuperChange(e.target.value as SuperCategory | "")}
                  disabled={busy || matchDisabled}
                >
                  <option value="">Pick a category</option>
                  {SUPER_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="kf-ipanel__editor-field">
                <span>
                  Sub-category
                  {!nameMatch && seededSub && cardIngredient ? (
                    <span className="kf-rvc__panel-from"> · from {cardIngredient.name}</span>
                  ) : null}
                  {matchDisabled && nameMatch ? (
                    <span className="kf-rvc__panel-from"> · set on {nameMatch.name}</span>
                  ) : null}
                </span>
                {subMode === "pick" ? (
                  <select
                    className="kf-ctl"
                    value={matchDisabled && nameMatch ? (nameMatch.parent ?? "") : subPick}
                    onChange={(e) => onSubPick(e.target.value)}
                    disabled={busy || matchDisabled}
                  >
                    <option value="">Pick a sub-category</option>
                    {parentOptions.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="kf-ctl"
                    value={subNew}
                    onChange={(e) => onSubNewChange(e.target.value)}
                    disabled={busy}
                  />
                )}
              </label>
            </div>
            {!matchDisabled ? (
              <button
                type="button"
                className="kf-rvc__panel-sublink"
                onClick={onSubModeToggle}
                disabled={busy}
              >
                {subMode === "pick" ? "+ add new sub-category" : "pick an existing sub-category"}
              </button>
            ) : null}
          </form>
          <WhatHappensBox
            wh={wh}
            checkedItems={checkedItems}
            memberCount={memberCount}
            costedPer={costedPer}
          />
        </>
      }
      error={error}
      scope={scope}
      foot={(tryClose) => (
        <>
          {intent !== "retail" ? (
            <button
              type="button"
              className="kf-rvc__panel-link"
              onClick={onQuietLink}
              disabled={!newFormReady || busy}
            >
              {linkLabel}
            </button>
          ) : null}
          <button
            type="button"
            className="kf-btn kf-btn--ghost kf-btn--sm"
            onClick={tryClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`kf-btn kf-btn--primary kf-btn--sm${op === "creating" ? " is-busy" : ""}`}
            onClick={onPrimary}
            disabled={!newFormReady || busy}
          >
            {primaryLabel}
          </button>
        </>
      )}
      onClose={onClose}
      busy={busy}
    />
  );
}
