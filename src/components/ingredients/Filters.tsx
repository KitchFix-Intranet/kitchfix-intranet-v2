"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { fmtCount } from "@/lib/fmt";

export type StatusSeg = "all" | "unlinked" | "catch_weight" | "no_number" | "not_food" | "duplicates";
type Vendor = { id: string; name: string };
type SegCounts = { all: number; unlinked: number; catch_weight: number; no_number: number; not_food: number; duplicates: number };

const SEGS: Array<{ k: StatusSeg; label: string }> = [
  { k: "all", label: "All" },
  { k: "unlinked", label: "Unlinked" },
  { k: "catch_weight", label: "Catch weight" },
  { k: "no_number", label: "No item number" },
  { k: "not_food", label: "Not food" },
  { k: "duplicates", label: "Duplicates" },
];

const PHONE_PER = 30;

export function Filters({
  vendors,
  selectedVendor,
  activeSeg,
  q,
  segCounts,
  pageSize,
}: {
  vendors: Vendor[];
  selectedVendor: string;
  activeSeg: StatusSeg;
  q: string;
  segCounts: SegCounts;
  pageSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(q);
  const [phone, setPhone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const m = window.matchMedia("(max-width: 860px)");
      setPhone(m.matches);
      const onChange = (e: MediaQueryListEvent) => setPhone(e.matches);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    } catch {
      // no-op
    }
  }, []);

  function navigate(mut: (u: URLSearchParams) => void) {
    const u = new URLSearchParams(sp?.toString() ?? "");
    u.delete("drawer");
    u.delete("page");
    mut(u);
    // Honor phone page size unless the caller already set `per`.
    if (phone && !u.has("per")) u.set("per", String(PHONE_PER));
    const qs = u.toString();
    startTransition(() => router.push(`${pathname}${qs ? `?${qs}` : ""}`));
  }

  function clearSearch() {
    setDraft("");
    navigate((u) => u.delete("q"));
    inputRef.current?.focus();
  }

  return (
    <div className={`kf-filters${pending ? " is-pending" : ""}`}>
      <div className="kf-filters__row">
        <label className="kf-field">
          <span>Vendor</span>
          <select
            value={selectedVendor}
            onChange={(e) =>
              navigate((u) => {
                if (e.target.value === "all") u.delete("vendor");
                else u.set("vendor", e.target.value);
              })
            }
          >
            <option value="all">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>

        <form
          className="kf-field kf-field--search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate((u) => {
              if (draft.length === 0) u.delete("q");
              else u.set("q", draft);
            });
          }}
        >
          <span className="kf-field__icon"><Search size={16} strokeWidth={1.5} /></span>
          <input
            ref={inputRef}
            type="search"
            placeholder="Description or item number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Search"
          />
          {draft.length > 0 ? (
            <button
              type="button"
              className="kf-field__clear"
              onClick={clearSearch}
              aria-label="Clear search"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          ) : (
            <kbd className="kf-field__kbd" aria-hidden>Enter</kbd>
          )}
        </form>
      </div>

      <div className="kf-segs" role="group" aria-label="Status">
        {SEGS.map((s) => (
          <button
            key={s.k}
            type="button"
            aria-pressed={activeSeg === s.k}
            className={`kf-seg${activeSeg === s.k ? " kf-seg--active" : ""}`}
            onClick={() =>
              navigate((u) => {
                if (s.k === "all") u.delete("status");
                else u.set("status", s.k);
              })
            }
          >
            <span>{s.label}</span>
            <b>{fmtCount(segCounts[s.k])}</b>
          </button>
        ))}
      </div>
    </div>
  );
}
