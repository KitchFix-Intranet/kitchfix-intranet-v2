"use client";

// Lane-local popover Menu primitive. role="menu" with keyboard nav
// (ArrowUp/Down, Home/End, Escape) and focus-return to the opener.
// Shared by:
//   - C3 "Change the page" menu (Add pages to it / Replace / Remove)
//   - C12 "..." menu (Delete this invoice)
//
// The menu is a popover anchored to the trigger by the parent's
// positioning rule (inv-rel + inv-menu). Escape and outside-click
// close it. The trigger stays mounted; the parent decides whether
// to render <Menu>.

import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE_ITEM = '[role="menuitem"]:not([disabled])';

interface MenuItemSpec {
  key: string;
  // Visible label.
  label: string;
  // Optional icon node drawn before the label.
  icon?: React.ReactNode;
  // Called when the item is picked. The Menu closes first (via
  // onClose) then invokes this on the next tick.
  onPick: () => void;
  // Make this item look destructive (red text). Default false.
  destructive?: boolean;
}

interface Props {
  // Accessible name for the menu.
  label: string;
  items: MenuItemSpec[];
  // Called when the user dismisses the menu (Escape, outside
  // click, or after picking an item).
  onClose: () => void;
  // Element the menu is anchored to - so clicks on it are not
  // treated as "outside". Optional: pass null and the menu will
  // treat any outside click as a dismiss.
  anchorRef?: React.RefObject<HTMLElement | null>;
  // Open-to side. "down-left" (default) draws below and left-
  // aligned; "down-right" below right-aligned.
  align?: "down-left" | "down-right";
}

export function Menu({ label, items, onClose, anchorRef, align = "down-left" }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Focus first item.
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>(FOCUSABLE_ITEM);
    first?.focus();
  }, []);

  // Outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (rootRef.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      onClose();
    };
    // Defer registration a tick so the opener's click does not
    // immediately close the menu.
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);
    return () => { window.clearTimeout(id); document.removeEventListener("mousedown", onDocClick); };
  }, [onClose, anchorRef]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_ITEM));
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "Escape":
        e.stopPropagation();
        onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        items[(i + 1 + items.length) % items.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        items[(i - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
    }
  }, [onClose]);

  const pick = useCallback((spec: MenuItemSpec) => {
    onClose();
    // Let the parent decide the next-tick action after the menu
    // unmounts. Keeps the focus-return path deterministic.
    window.setTimeout(() => spec.onPick(), 0);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className={`kf-inv-menu kf-inv-menu--${align}`}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className={`kf-inv-menu__item${it.destructive ? " is-destructive" : ""}`}
          onClick={() => pick(it)}
        >
          {it.icon ? <span className="kf-inv-menu__icon" aria-hidden>{it.icon}</span> : null}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
