"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X as XIcon, Plus, Search, Scissors, Ban } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";

export type ReviewMemberItem = {
  id: string;
  name: string;
  confidence: string | null;
};

type Ingredient = { id: string; name: string; parent: string | null };

type Props = {
  groupKey: string;
  kind: "existing" | "new";
  currentIngredientId: string | null;
  proposedName: string | null;
  proposedParent: string | null;
  memberItems: ReviewMemberItem[];
  ingredients: Ingredient[];
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
  groupKey,
  kind,
  currentIngredientId,
  proposedName,
  proposedParent,
  memberItems,
  ingredients,
}: Props) {
  const router = useRouter();
  const [op, setOp] = useState<Op>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const m of memberItems) init[m.id] = true;
    return init;
  });
  const [showRelink, setShowRelink] = useState(false);
  const [relinkId, setRelinkId] = useState<string>("");
  const [newName, setNewName] = useState(proposedName ?? "");
  const [newParent, setNewParent] = useState(proposedParent ?? "");
  const [showNew, setShowNew] = useState(false);
  const checkedIds = memberItems.filter((m) => checked[m.id]).map((m) => m.id);
  const checkedCount = checkedIds.length;

  async function confirmChecked() {
    if (op || checkedCount === 0) return;
    if (kind === "new") {
      // Must create the ingredient first; use the proposed name/parent.
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
    const d = r.data as { confirmed?: number; usd?: number };
    const confirmedIds = [...checkedIds];
    toast(`Confirmed ${fmtCount(d.confirmed ?? checkedCount)} items`, {
      undo: async () => {
        // Short-lived Undo in the toast (6s auto-dismiss). The ledger
        // below the queue has a durable Undo for later.
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
    if (op || checkedCount === 0 || !relinkId) return;
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
    if (op || checkedCount === 0) return;
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
        // Short-lived Undo in the toast; the ingredient itself stays
        // created (undo only reverts the item confirms, since the
        // ingredient may already be used by other items).
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
    if (op || checkedCount === 0) return;
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
    if (op || checkedCount === 0) return;
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

  const allChecked = memberItems.length > 0 && checkedCount === memberItems.length;
  const noneChecked = checkedCount === 0;

  return (
    <div className="kf-rvc__actions">
      <div className="kf-rvc__select-row">
        <label className="kf-rvc__select-all">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) => {
              const v = e.currentTarget.checked;
              const next: Record<string, boolean> = {};
              for (const m of memberItems) next[m.id] = v;
              setChecked(next);
            }}
          />
          <span>
            {checkedCount} of {memberItems.length} selected
          </span>
        </label>
        {memberItems.length > 1 ? (
          <details className="kf-rvc__itemlist">
            <summary>Pick individual items</summary>
            <ul>
              {memberItems.map((m) => (
                <li key={m.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!checked[m.id]}
                      onChange={(e) =>
                        setChecked((prev) => ({ ...prev, [m.id]: e.currentTarget.checked }))
                      }
                    />
                    <span>{m.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
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
