"use client";

// Inline "Saved just now" badge. Pass a `savedAt` timestamp (Date.now())
// after a successful write; the badge renders for 2.5s then hides.
// Error flashes also live here via `error` string.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0. Markup and
// classes unchanged.

import { useEffect, useState } from "react";
import { Check } from "lucide-react";

export function SaveFlash({ savedAt, error }: { savedAt: number | null; error: string | null }) {
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (!savedAt) {
      setShowSaved(false);
      return;
    }
    setShowSaved(true);
    const t = window.setTimeout(() => setShowSaved(false), 2500);
    return () => window.clearTimeout(t);
  }, [savedAt]);
  if (error) {
    return <span className="kf-dpn__flash kf-dpn__flash--err" role="alert">{error}</span>;
  }
  if (showSaved) {
    return (
      <span className="kf-dpn__flash kf-dpn__flash--ok" aria-live="polite">
        <Check size={14} strokeWidth={2} aria-hidden />
        <span>Saved</span>
      </span>
    );
  }
  return null;
}
