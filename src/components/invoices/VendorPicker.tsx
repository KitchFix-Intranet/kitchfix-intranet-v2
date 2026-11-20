"use client";

// Vendor picker. Opens inside a lane Sheet so phones get the
// full viewport and desk gets a centered dialog. Rows are grouped
// by "This site" / "Other vendors"; the currently picked vendor
// is marked. Arrow keys move the focus ring through the rows;
// Enter picks; Escape closes.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Plus, Search } from "lucide-react";
import { Sheet } from "./Sheet";

interface VendorPick {
  id: string;
  name: string;
  category: string | null;
  isSiteVendor: boolean;
}

export function VendorPicker({
  siteSlug,
  asParam,
  currentVendorId,
  onPick,
  onClose,
}: {
  siteSlug: string;
  asParam: string | null;
  currentVendorId: string | null;
  onPick: (v: VendorPick) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<VendorPick[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const asQ = asParam ? `&as=${encodeURIComponent(asParam)}` : "";

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(async () => {
      setLoading(true);
      const u = `/api/invoices/vendors?site=${encodeURIComponent(siteSlug)}&q=${encodeURIComponent(q)}${asQ}`;
      const res = await fetch(u).catch(() => null);
      if (!res || cancelled) { setLoading(false); return; }
      if (!res.ok) { setLoading(false); setRows([]); return; }
      const body = (await res.json()) as { vendors: VendorPick[] };
      setRows(body.vendors ?? []);
      setLoading(false);
    }, 180);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q, siteSlug, asQ]);

  const siteVendors = rows.filter((v) => v.isSiteVendor);
  const others = rows.filter((v) => !v.isSiteVendor);
  const flat = [...siteVendors, ...others];

  const onSearchKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && flat.length > 0) {
      e.preventDefault();
      const first = listRef.current?.querySelector<HTMLButtonElement>("button");
      first?.focus();
    }
  }, [flat.length]);

  const onListKey = useCallback((e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i <= 0) {
        inputRef.current?.focus();
      } else {
        items[i - 1]?.focus();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  return (
    <Sheet title="Pick the vendor" onClose={onClose} variant="centered">
      <label className="kf-inv-vendor-picker__search">
        <span className="kf-sr-only">Search vendors</span>
        <Search size={18} strokeWidth={1.75} aria-hidden />
        <input
          ref={inputRef}
          data-autofocus
          type="search"
          placeholder="Search by name"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value.slice(0, 80))}
          onKeyDown={onSearchKey}
          autoComplete="off"
        />
      </label>

      {loading ? <p className="kf-inv-sitting__hint">Looking...</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="kf-inv-sitting__hint">
          Not on the list? Asking for a new vendor arrives with Vendors.
        </p>
      ) : null}

      <ul className="kf-inv-vendor-picker__list" ref={listRef} onKeyDown={onListKey} role="listbox" aria-label="Vendors">
        {siteVendors.length > 0 ? (
          <li className="kf-inv-vendor-picker__group" aria-hidden>This site</li>
        ) : null}
        {siteVendors.map((v) => (
          <VendorRow key={v.id} v={v} picked={v.id === currentVendorId} onPick={() => onPick(v)} />
        ))}
        {others.length > 0 ? (
          <li className="kf-inv-vendor-picker__group" aria-hidden>Other vendors</li>
        ) : null}
        {others.map((v) => (
          <VendorRow key={v.id} v={v} picked={v.id === currentVendorId} onPick={() => onPick(v)} />
        ))}
      </ul>

      <p className="kf-inv-vendor-picker__foot">
        <Plus size={16} strokeWidth={1.75} aria-hidden /> Not on the list? Asking for a new vendor arrives with Vendors.
      </p>
    </Sheet>
  );
}

function VendorRow({ v, picked, onPick }: { v: VendorPick; picked: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={picked ? true : undefined}
        className={`kf-inv-vendor-picker__item${picked ? " is-picked" : ""}`}
        onClick={onPick}
      >
        <span className="kf-inv-vendor-picker__item-name">{v.name}</span>
        <span className="kf-inv-vendor-picker__item-tag">
          {picked ? <Check size={18} strokeWidth={2} aria-hidden /> : null}
          {v.isSiteVendor ? "This site" : v.category ?? ""}
        </span>
      </button>
    </li>
  );
}
