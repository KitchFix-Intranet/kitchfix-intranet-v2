"use client";

import { useRouter } from "next/navigation";
import type { ReactNode, KeyboardEvent, MouseEvent } from "react";

// Whole-row-clickable <tr>. onClick / Enter pushes the drawer URL; the row
// is focusable and shows a focus ring. Clicks on nested interactive elements
// (buttons, links) stop propagation so they still work.

type Props = {
  href: string;
  rowId?: string;
  children: ReactNode;
  className?: string;
};

export function RowLink({ href, rowId, children, className }: Props) {
  const router = useRouter();
  const go = () => {
    try {
      if (rowId) sessionStorage.setItem("kf.drawer.from-row", rowId);
    } catch {
      // non-fatal
    }
    router.push(href);
  };

  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("a, button, input, select, textarea")) return;
    go();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  };

  return (
    <tr
      className={`kf-row-link${className ? ` ${className}` : ""}`}
      role="link"
      tabIndex={0}
      data-row-id={rowId}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
    </tr>
  );
}
