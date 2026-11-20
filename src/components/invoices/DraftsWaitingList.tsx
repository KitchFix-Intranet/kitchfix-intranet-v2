"use client";

// Drafts waiting (B6). Each row is a 48 px line showing:
//   - vendor name or "No vendor yet"
//   - invoice number if typed
//   - "Ready" or a short missing-list
//   - when it was last touched
// A Remove icon button discards the draft at once and raises an
// Undo toast through the shared toaster. On undo the row returns
// via the POST /undo route. No confirm() dialog.

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { timeAgo } from "@/lib/fmt";
import type { DraftListView } from "@/lib/invoices/types";

export function DraftsWaitingList({
  drafts,
  siteSlug,
  asParam,
}: {
  drafts: readonly DraftListView[];
  siteSlug: string;
  asParam: string | null;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const asQ = asParam ? `?as=${encodeURIComponent(asParam)}` : "";
  const asQAmp = asParam ? `&as=${encodeURIComponent(asParam)}` : "";

  const visible = drafts.filter((d) => !hidden.has(d.id));

  const remove = async (d: DraftListView) => {
    setHidden((h) => new Set(h).add(d.id));
    const res = await fetch(`/api/invoices/drafts/${d.id}/discard${asQ}`, { method: "POST" });
    if (!res.ok) {
      setHidden((h) => { const n = new Set(h); n.delete(d.id); return n; });
      toast("That did not remove. Try again.", { tone: "block" });
      return;
    }
    toast(`Removed ${d.vendor_name ?? "it"}.`, {
      tone: "ink",
      undo: async () => {
        const r = await fetch(`/api/invoices/drafts/${d.id}/undo${asQ}`, { method: "POST" });
        if (r.ok) {
          setHidden((h) => { const n = new Set(h); n.delete(d.id); return n; });
          router.refresh();
        } else {
          toast("Could not put it back.", { tone: "block" });
        }
      },
    });
    router.refresh();
  };

  if (visible.length === 0) {
    return <p className="kf-inv-sitting__hint">Nothing yet. Drop a file above to start.</p>;
  }

  return (
    <ul className="kf-inv-capture__drafts">
      {visible.map((d) => {
        const vendor = d.vendor_name ?? "No vendor yet";
        const num = d.invoice_number ? `#${d.invoice_number}` : "No number";
        // Ride 8.4: "Copy to settle" is terminal and never gets
        // the " left" suffix. When present it blocks the Ready
        // check, so show it alone.
        const status = d.ready
          ? "Ready"
          : d.missing.includes("Copy to settle")
            ? "Copy to settle"
            : d.missing.length > 0 ? d.missing.join(", ") + " left" : "In progress";
        return (
          <li key={d.id} className="kf-inv-capture__draft">
            <Link
              className="kf-inv-capture__draft__main"
              href={`/invoices?site=${siteSlug}&draft=${d.id}${asQAmp}`}
            >
              <span className="kf-inv-capture__draft__name">{vendor}</span>
              <span className="kf-inv-capture__draft__meta">
                <span>{num}</span>
                <span className={`kf-inv-capture__draft__status${d.ready ? " is-ready" : ""}`}>
                  {status}
                </span>
                <span className="kf-inv-capture__draft__when">{timeAgo(d.updated_at)}</span>
              </span>
            </Link>
            <button
              type="button"
              className="kf-inv-capture__draft__remove"
              aria-label={`Remove draft for ${vendor}`}
              onClick={() => void remove(d)}
            >
              <Trash2 size={18} strokeWidth={1.75} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
