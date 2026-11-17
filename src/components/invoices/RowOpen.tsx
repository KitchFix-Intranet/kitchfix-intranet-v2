"use client";

// Row openers.
//
// `TableRowOpen` wraps a <tr> inside a real <table>. It opens the
// drawer on click anywhere that is not a nested interactive element.
// `CardRowOpen` does the same for the stacked-card layout, rendering
// a plain <div>. The card has NO role, NO tabIndex, and NO keydown
// handler: the keyboard path is the vendor <button> inside it.
// `RowVendorButton` is the real button in the vendor cell. It
// carries `data-inv-id` so the drawer close logic can return focus
// to the visible instance (table vs card layouts both exist in the
// DOM at the same time; CSS @container queries hide one with
// display:none).

import { useRouter } from "next/navigation";
import { useCallback } from "react";

function isInteractive(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  return !!target.closest("a, button, input, select, textarea, [role='button']");
}

export function TableRowOpen({
  children,
  href,
  className,
}: {
  children: React.ReactNode;
  href: string;
  className?: string;
}) {
  const router = useRouter();
  const onClick = useCallback((e: React.MouseEvent<HTMLTableRowElement>) => {
    if (isInteractive(e.target)) return;
    router.push(href);
  }, [router, href]);
  return (
    <tr className={className} onClick={onClick}>
      {children}
    </tr>
  );
}

export function CardRowOpen({
  children,
  href,
  className,
}: {
  children: React.ReactNode;
  href: string;
  className?: string;
}) {
  const router = useRouter();
  const onClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (isInteractive(e.target)) return;
    router.push(href);
  }, [router, href]);
  return (
    <div className={className} onClick={onClick}>
      {children}
    </div>
  );
}

export function RowVendorButton({
  invId,
  href,
  vendorName,
}: {
  invId: string;
  href: string;
  vendorName: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      data-inv-id={invId}
      className="kf-invoices-row__vendorbtn"
      onClick={() => router.push(href)}
    >
      {vendorName || "-"}
    </button>
  );
}
