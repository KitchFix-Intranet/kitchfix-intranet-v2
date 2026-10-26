"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { fmtCount } from "@/lib/fmt";

// NOTE: do NOT add a `format` function prop here. A function cannot cross
// the Server->Client boundary (RSC payload is not able to serialize it;
// React throws #441 at render, not at build). CountUp owns its formatter
// (fmtCount), which is the only one tiles need. See docs/GOTCHAS.md.
type Props = {
  value: number;
  durationMs?: number;
};

function wasRevealed(pathname: string): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav?.type === "back_forward") return true;
    return sessionStorage.getItem(`kf.revealed:${pathname}`) !== null;
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Hydration-safe count-up. The server renders the final formatted value
// inside the span with inline visibility:hidden so JS-off still shows a
// number and hydration never sees a mismatch; on mount we flip visible and
// animate from 0 to value over 600ms with a cubic ease-out. Skipped when
// the value is 0, under reduced motion, or when RevealGate says the route
// already played this session.
export function CountUp({ value, durationMs = 600 }: Props) {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(value);
  const pathname = usePathname();
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setMounted(true);
    if (value === 0 || wasRevealed(pathname) || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(value * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else setShown(value);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs, pathname]);

  return (
    <span style={mounted ? undefined : { visibility: "hidden" }}>
      {fmtCount(shown)}
    </span>
  );
}
