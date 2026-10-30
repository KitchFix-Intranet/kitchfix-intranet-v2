"use client";

// Stateless action bar for a review card. Selection state (which items
// are checked) lives in the parent ReviewCard - this component just
// receives the already-filtered checkedIds + a few summary fields and
// acts on them. The former "Pick individual items" expander is gone;
// every item row carries a visible checkbox now (ReviewCard owns the
// per-row rendering).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X as XIcon, Plus, Scissors, Ban, Search, ShoppingBag, Archive, Loader2, Flag } from "lucide-react";
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

type Op = null | "confirming" | "relinking" | "creating" | "notfood" | "resale" | "archived" | "keepsep" | "flag";

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

export function ReviewActions({
  kind,
  currentIngredientId,
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
    const d = r.data as { confirmed?: number };
    const confirmedIds = [...checkedIds];
    toast(`Confirmed ${fmtCount(d.confirmed ?? checkedCount)} items`, {
      tone: "good",
      undo: async () => {
        for (const id of confirmedIds) {
          await postJson("/api/review/undo", { itemId: id });
        }
        router.refresh();
      },
    });
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
    const r = await postJson("/api/review/new-ingredient", {
      name,
      parent: effectiveSub || null,
      category: newSuper || null,
      itemIds: checkedIds,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Create failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    const d = r.data as { ingredientId?: string; moved?: number };
    toast(
      `Created "${name}" - ${fmtCount(d.moved ?? checkedCount)} items moved; confirm them on the new card.`
    );
    setShowNew(false);
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

  // Retail disposition. Items sold as-is to players (bottled water,
  // snacks, pre-made sandwiches): real spend but not a recipe
  // ingredient. The overview views already read status='resale' to
  // bucket these as retail; this action writes that + rejects the
  // link so the item drops out of the queue.
  async function markResale() {
    if (op || noneChecked) return;
    setOp("resale");
    const r = await postJson("/api/review/resale", { itemIds: checkedIds });
    if (!r.ok) {
      toast(errMsg(r.data, `Mark failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    toast(`Marked ${fmtCount(checkedCount)} as retail`);
    setOp(null);
    setLastDone(Date.now());
    router.refresh();
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
          title="One-off / irrelevant food purchase; parked and not tracked in recipe coverage or retail"
        >
          <Archive size={14} strokeWidth={1.5} />
          <span>{op === "archived" ? "Saving..." : "Archive"}</span>
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
        (water, snacks, sandwiches) &middot; <strong>Archive</strong> = one-off / not tracked
        &middot; <strong>Not food</strong> = not a consumable (fees, freight).
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
            It&rsquo;ll land in the queue under its own card so you can confirm there.
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

          <div className="kf-rvc__panel-btns">
            <button
              type="button"
              className={`kf-btn kf-btn--primary kf-btn--sm${op === "creating" ? " is-busy" : ""}`}
              disabled={op !== null || !newFormReady}
              onClick={doCreateSplit}
            >
              Create ingredient
            </button>
            <button
              type="button"
              className="kf-btn kf-btn--ghost kf-btn--sm"
              onClick={() => setShowNew(false)}
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
