"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Tag } from "lucide-react";
import { toast } from "@/components/ui/Toaster";

type Props = { id: string; status: string; closeHref: string };

async function post(id: string, status: string): Promise<string | null> {
  const res = await fetch(`/api/vendor-items/${id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (res.ok) return null;
  try {
    const body = await res.text();
    return body || `Status ${res.status}`;
  } catch {
    return `Status ${res.status}`;
  }
}

export function ItemStatusActions({ id, status, closeHref }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "archived" | "one_off">(null);

  async function set(next: "archived" | "one_off", successCopy: string) {
    if (busy) return;
    setBusy(next);
    const prior = status;
    const err = await post(id, next);
    if (err) {
      toast(err, { tone: "block" });
      setBusy(null);
      return;
    }
    toast(successCopy, {
      undo: async () => {
        const errUndo = await post(id, prior);
        if (errUndo) {
          toast(errUndo, { tone: "block" });
          return;
        }
        router.refresh();
      },
    });
    router.push(closeHref);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className={`kf-btn kf-btn--line kf-btn--sm${busy === "archived" ? " is-busy" : ""}`}
        disabled={busy !== null || status === "archived"}
        onClick={() => set("archived", "Archived")}
      >
        <Archive size={14} strokeWidth={1.5} />
        <span>Archive</span>
      </button>
      <button
        type="button"
        className={`kf-btn kf-btn--line kf-btn--sm${busy === "one_off" ? " is-busy" : ""}`}
        disabled={busy !== null || status === "one_off"}
        onClick={() => set("one_off", "Marked one-off")}
      >
        <Tag size={14} strokeWidth={1.5} />
        <span>Mark one-off</span>
      </button>
    </>
  );
}
