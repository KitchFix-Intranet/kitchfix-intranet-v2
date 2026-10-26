"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";

type Props = {
  email: string;
  name: string;
  slim: boolean;
};

function initials(name: string, email: string): string {
  const base = name && name.length > 0 ? name : email.split("@")[0] ?? "";
  const parts = base
    .replace(/[._]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function AccountMenu({ email, name, slim }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = name && name.length > 0 ? name : email;
  const ini = initials(name, email);

  return (
    <div className="kf-account" ref={rootRef}>
      <button
        type="button"
        className={`kf-account__btn${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="kf-account__ini" aria-hidden>{ini}</span>
        {slim ? null : (
          <span className="kf-account__who">
            <span className="kf-account__name">{label}</span>
            <span className="kf-account__email" title={email}>{email}</span>
          </span>
        )}
        {slim ? null : <ChevronDown size={16} strokeWidth={1.5} className="kf-account__caret" />}
      </button>
      {open ? (
        <div className={`kf-account__menu${slim ? " kf-account__menu--slim" : ""}`} role="menu">
          <form action="/api/auth/signout" method="post">
            <button type="submit" className="kf-account__item" role="menuitem">
              <LogOut size={16} strokeWidth={1.5} />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
