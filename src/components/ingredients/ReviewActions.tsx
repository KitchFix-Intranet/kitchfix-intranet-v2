"use client";

// Stateless action bar for a review card. Selection state (which items
// are checked) lives in the parent ReviewCard - this component just
// receives the already-filtered checkedIds + a few summary fields and
// acts on them. The former "Pick individual items" expander is gone;
// every item row carries a visible checkbox now (ReviewCard owns the
// per-row rendering).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X as XIcon, Plus, Search, Scissors, Ban } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";

// Kept exported so other call sites that import it keep compiling even
// though ReviewCard no longer passes a memberItems prop.
export type ReviewMemberItem = {
  id: string;
  name: string;
  confidence: string | null;
};

type Ingredient = { id: string; name: string; parent: string | null };

type Props = {
  kind: "existing" | "new";
  currentIngredientId: string | null;
  proposedName: string | null;
  proposedParent: string | null;
  ingredients: Ingredient[];
  checkedIds: string[];
  checkedCount: number;
  memberCount: number;
};

type Op = null | "confirming" | "relinking" | "creating" | "notfood" | "keepsep";

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
  checkedCount,
  memberCount,
}: Props) {
  const router = useRouter();
  const [op, setOp] = useState<Op>(null);
  const [showRelink, setShowRelink] = useState(false);
  const [relinkId, setRelinkId] = useState<string>("");
  const [newName, setNewName] = useState(proposedName ?? "");
  const [newParent, setNewParent] = useState(proposedParent ?? "");
  const [showNew, setShowNew] = useState(false);

  const noneChecked = checkedCount === 0;

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
      undo: async () => {
        for (const id of confirmedIds) {
          await postJson("/api/review/undo", { itemId: id });
        }
        router.refresh();
      },
    });
    setOp(null);
    router.refresh();
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
    router.refresh();
  }

  async function createAndConfirm() {
    if (op || noneChecked) return;
    const name = newName.trim();
    if (name.length < 2) {
      toast("Ingredient name is required", { tone: "block" });
      return;
    }
    setOp("creating");
    const r = await postJson("/api/review/new-ingredient", {
      name,
      parent: newParent.trim() || null,
      itemIds: checkedIds,
    });
    if (!r.ok) {
      toast(errMsg(r.data, `Create failed (${r.status})`), { tone: "block" });
      setOp(null);
      return;
    }
    const d = r.data as { confirmed?: number; ingredientId?: string };
    const confirmedIds = [...checkedIds];
    toast(`Created "${name}" and confirmed ${fmtCount(d.confirmed ?? checkedCount)} items`, {
      undo: async () => {
        for (const id of confirmedIds) {
          await postJson("/api/review/undo", { itemId: id });
        }
        router.refresh();
      },
    });
    setShowNew(false);
    setOp(null);
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
    router.refresh();
  }

  return (
    <div className="kf-rvc__actions">
      <div className="kf-rvc__actions-summary">
        <span>
          <strong>{fmtCount(checkedCount)}</strong> of {fmtCount(memberCount)} selected
        </span>
      </div>

      <div className="kf-rvc__btns">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-btn--sm${op === "confirming" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={confirmChecked}
        >
          <Check size={14} strokeWidth={1.5} />
          <span>{kind === "new" ? "Create & confirm" : "Confirm"}</span>
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
          <span>Keep separate</span>
        </button>

        <button
          type="button"
          className={`kf-btn kf-btn--ghost kf-btn--sm${op === "notfood" ? " is-busy" : ""}`}
          disabled={op !== null || noneChecked}
          onClick={markNotFood}
        >
          <Ban size={14} strokeWidth={1.5} />
          <span>Not food</span>
        </button>
      </div>

      {showRelink ? (
        <div className="kf-rvc__panel">
          <label>
            <span>Reassign to</span>
            <select value={relinkId} onChange={(e) => setRelinkId(e.target.value)}>
              <option value="">Pick an ingredient...</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}{i.parent ? ` - ${i.parent}` : ""}
                </option>
              ))}
            </select>
          </label>
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
        <div className="kf-rvc__panel">
          <label>
            <span>New ingredient name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={proposedName ?? "e.g. Smoked paprika"}
              autoFocus
            />
          </label>
          <label>
            <span>Parent (optional)</span>
            <input
              type="text"
              value={newParent}
              onChange={(e) => setNewParent(e.target.value)}
              placeholder={proposedParent ?? "e.g. Spices"}
            />
          </label>
          <div className="kf-rvc__panel-btns">
            <button
              type="button"
              className={`kf-btn kf-btn--primary kf-btn--sm${op === "creating" ? " is-busy" : ""}`}
              disabled={op !== null || newName.trim().length < 2}
              onClick={createAndConfirm}
            >
              Create and confirm
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
