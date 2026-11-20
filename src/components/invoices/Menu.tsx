"use client";

// Lane-local popover Menu primitive. role="menu" with keyboard nav
// (ArrowUp/Down, Home/End, Escape, Enter/Space on items) and
// focus-return to the opener on close.
//
// Shared by:
//   - C3 "Change the page" menu (Add pages to it / Replace / Remove)
//   - C12 "..." menu (Delete this invoice)
//
// The menu is a popover anchored to the trigger by the parent's
// positioning rule (inv-rel + inv-menu). Escape and outside-click
// close it. The trigger stays mounted; the parent decides whether
// to render <Menu>.
//
// Train 2b fix 1 / 2.2: on unmount (Escape, outside-click, pick,
// explicit close), focus returns to whatever had focus at the
// moment the Menu first mounted - i.e. the trigger that opened
// it. If that element has been detached from the DOM (the opener
// was unmounted during a navigation), focus stays where it is and
// the destination page's own mount-focus takes over.

import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE_ITEM = '[role="menuitem"]:not([disabled])';

interface MenuItemSpec {
  key: string;
  label: string;
  icon?: React.ReactNode;
  // Called when the item is picked. The Menu closes first (via
  // onClose) then invokes this on the next tick so focus-return
  // happens before any destination navigation.
  onPick: () => void;
  // Destructive items render in red. Kept for Change-the-page's
  // "Remove the file" (an action that cannot be undone in one
  // click when a file is the only one on the draft). Train 2b
  // fix 1 / 2.4 removes this flag from "Delete this invoice"
  // because Delete carries an Undo.
  destructive?: boolean;
}

interface Props {
  label: string;
  items: MenuItemSpec[];
  onClose: () => void;
  // Optional: clicks on this element are not treated as
  // outside-the-menu. The trigger is a natural fit.
  anchorRef?: React.RefObject<HTMLElement | null>;
  align?: "down-left" | "down-right";
}

export function Menu({ label, items, onClose, anchorRef, align = "down-left" }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Remember what had focus before the menu opened; move focus to
  // the first item; give focus back on unmount. Same pattern as
  // Sheet.tsx.
  useEffect(() => {
    const previously = document.activeElement;
    if (previously instanceof HTMLElement) returnFocusRef.current = previously;
    const first = rootRef.current?.querySelector<HTMLElement>(FOCUSABLE_ITEM);
    first?.focus();
    return () => {
      const el = returnFocusRef.current;
      if (el && typeof el.focus === "function" && document.contains(el)) el.focus();
    };
  }, []);

  // Outside-click close. `mousedown` is fine here because the item
  // onClick fires AFTER mousedown/mouseup; and when the user
  // presses an item, the mousedown target is contained in rootRef,
  // so the handler short-circuits before firing onClose. (This is
  // only safe with one Menu mounted at a time - train 2b fix 1
  // ensures that.)
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (rootRef.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      onClose();
    };
    // Defer registration so the opener's click that just opened
    // the menu doesn't immediately close it.
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDocDown), 0);
    return () => { window.clearTimeout(id); document.removeEventListener("mousedown", onDocDown); };
  }, [onClose, anchorRef]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_ITEM));
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "Escape":
        e.stopPropagation();
        e.preventDefault();
        onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        list[(i + 1 + list.length) % list.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        list[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        list[list.length - 1]?.focus();
        break;
    }
  }, [onClose]);

  const pick = useCallback((spec: MenuItemSpec) => {
    onClose();
    // Next tick so unmount + focus-return runs before the
    // destination action (the action may navigate).
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
