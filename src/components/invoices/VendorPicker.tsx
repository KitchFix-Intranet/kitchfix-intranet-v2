"use client";

// Vendor picker dialog. Keyboard-first, focus-trapped.

import { useCallback, useEffect, useRef, useState } from "react";

interface VendorPick {
  id: string;
  name: string;
  category: string | null;
  isSiteVendor: boolean;
}

export function VendorPicker({
  siteSlug,
  asParam,
  onPick,
  onClose,
}: {
  siteSlug: string;
  asParam: string | null;
  onPick: (v: VendorPick) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<VendorPick[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const asQ = asParam ? `&as=${encodeURIComponent(asParam)}` : "";

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const onBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <div className="kf-inv-vendor-picker__backdrop" role="dialog" aria-modal="true" aria-label="Pick a vendor" onClick={onBackdropClick}>
      <div className="kf-inv-vendor-picker__panel">
        <h3>Pick a vendor</h3>
        <input
          ref={inputRef}
          type="search"
          placeholder="Search by name"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value.slice(0, 80))}
          aria-label="Search vendors"
        />
        {loading ? <p className="kf-inv-sitting__hint">Looking...</p> : null}
        {rows.length === 0 && !loading ? (
          <p className="kf-inv-sitting__hint">
            Not on the list? Asking for a new vendor arrives with Vendors.
          </p>
        ) : null}
        <ul className="kf-inv-vendor-picker__list">
          {rows.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                className={`kf-inv-vendor-picker__item${v.isSiteVendor ? " is-site-vendor" : ""}`}
                onClick={() => onPick(v)}
              >
                <span>{v.name}</span>
                <span className="kf-inv-vendor-picker__item-tag">
                  {v.isSiteVendor ? "This site" : v.category ?? ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="kf-btn kf-btn--line" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
