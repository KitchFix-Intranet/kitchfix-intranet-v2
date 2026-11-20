"use client";

// Train 2b correction 7 / D4: pin the phone action bar above the
// on-screen keyboard without touching the shared viewport meta.
// Reads window.visualViewport and reports how many pixels the
// keyboard covers (0 when it is down). Consumers add that number
// to the action bar's `bottom` so the bar rises with the keyboard.
//
// Browsers without visualViewport (very old Safari) return 0 and
// the bar sits at --sp-tabbar as usual.

import { useEffect, useState } from "react";

export function useKeyboardOffset(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const read = () => {
      // Keyboard-covered area = inner height - visual viewport height
      // - viewport top offset. Clamp to >= 0.
      const covered = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      setH(covered);
    };
    read();
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    return () => {
      vv.removeEventListener("resize", read);
      vv.removeEventListener("scroll", read);
    };
  }, []);
  return h;
}
