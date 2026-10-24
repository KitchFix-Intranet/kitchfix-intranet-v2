"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";

export type StatusSeg = "all" | "unlinked" | "catch_weight" | "no_number" | "not_food" | "duplicates";
type Vendor = { id: string; name: string };

const SEGS: Array<{ k: StatusSeg; label: string }> = [
  { k: "all", label: "All" },
  { k: "unlinked", label: "Unlinked" },
  { k: "catch_weight", label: "Catch weight" },
  { k: "no_number", label: "No item number" },
  { k: "not_food", label: "Not food" },
  { k: "duplicates", label: "Duplicates" },
];

export function Filters({
  vendors,
  selectedVendor,
  activeSeg,
  q,
}: {
  vendors: Vendor[];
  selectedVendor: string;
  activeSeg: StatusSeg;
  q: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(q);

  function navigate(mut: (u: URLSearchParams) => void) {
    const u = new URLSearchParams(sp?.toString() ?? "");
    u.delete("drawer");
    u.delete("page");
    mut(u);
    startTransition(() => router.push(`${pathname}?${u.toString()}`));
  }

  return (
    <div className="kf-filters">
      <div className="kf-filters__row">
        <label className="kf-field">
          <span>Vendor</span>
          <select
            value={selectedVendor}
            onChange={(e) => navigate((u) => { if (e.target.value === "all") u.delete("vendor"); else u.set("vendor", e.target.value); })}
          >
            <option value="all">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>

        <form
          className="kf-field kf-field--search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate((u) => { if (draft.length === 0) u.delete("q"); else u.set("q", draft); });
          }}
        >
          <span className="kf-field__icon"><Search size={16} strokeWidth={1.5} /></span>
          <input
            type="search"
            placeholder="Search description or item number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      </div>

      <div className="kf-segs" role="tablist" aria-label="Status">
        {SEGS.map((s) => (
          <button
            key={s.k}
            type="button"
            role="tab"
            aria-selected={activeSeg === s.k}
            className={`kf-seg${activeSeg === s.k ? " kf-seg--active" : ""}`}
            onClick={() => navigate((u) => { if (s.k === "all") u.delete("status"); else u.set("status", s.k); })}
          >
            {s.label}
          </button>
        ))}
      </div>

      {pending ? <div className="kf-filters__pending" aria-live="polite">Loading...</div> : null}
    </div>
  );
}
