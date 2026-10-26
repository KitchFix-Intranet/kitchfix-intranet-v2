"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Marks the canvas root with `is-revealed` after the first visit per route in
// a session, which disables the reveal animation and the CountUp. Browser
// back/forward counts as revealed.

export function RevealGate() {
  const pathname = usePathname();
  useEffect(() => {
    const canvas = document.querySelector(".kf-canvas") as HTMLElement | null;
    if (!canvas) return;
    try {
      const key = `kf.revealed:${pathname}`;
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const isBF = nav?.type === "back_forward";
      if (isBF || sessionStorage.getItem(key)) {
        canvas.classList.add("is-revealed");
      } else {
        sessionStorage.setItem(key, "1");
      }
    } catch {
      // non-fatal
    }
  }, [pathname]);
  return null;
}
