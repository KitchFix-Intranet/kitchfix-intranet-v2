"use client";

// Hydration-safe count-up for a single integer value. The server
// renders the final formatted value with inline visibility: hidden;
// the client mounts, becomes visible, then animates from 0 to the
// value over 600ms with tabular-nums. Skipped when the value is 0,
// under reduced motion, or when <RevealGate> says the route already
// played (we read the same sessionStorage key). See docs/DESIGN.md
// section 9 (motion).

import { useEffect, useRef, useState } from "react";

const REVEAL_KEY_PREFIX = "kf.reveal.";

function reducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function alreadyRevealed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = REVEAL_KEY_PREFIX + window.location.pathname;
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

type Props = {
  value: number;
  // Rendered as the final formatted string. SSR renders this literal.
  format?: (n: number) => string;
  // Suffix spans next to the number (e.g. "min"). Count-up ignores
  // the suffix; the number itself is what animates.
  className?: string;
};

export function CountUp({ value, format, className }: Props) {
  const [mounted, setMounted] = useState(false);
  const [current, setCurrent] = useState<number>(value);
  const skipRef = useRef<boolean>(false);

  // Mark mounted so the server-rendered hidden span fades in (CSS)
  // and we start animating from 0 to value if we are supposed to.
  useEffect(() => {
    setMounted(true);
    if (value <= 0) { skipRef.current = true; setCurrent(value); return; }
    if (reducedMotion() || alreadyRevealed()) { skipRef.current = true; setCurrent(value); return; }
    setCurrent(0);
    const start = performance.now();
    const dur = 600;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - p, 3);
      setCurrent(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const text = format ? format(current) : String(current);
  // Server + first client render show the final value hidden to avoid
  // the "flash final -> 0 -> final" bug (GOTCHA #5). After mount we
  // flip visible and let the animation handle the rest.
  return (
    <span
      className={className}
      style={{
        visibility: mounted ? "visible" : "hidden",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {text}
    </span>
  );
}
