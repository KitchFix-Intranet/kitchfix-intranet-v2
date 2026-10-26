"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Mounted inside the identity band when the newest run is still 'running'.
// Soft-refreshes the server once every 15 s so the band flips to the ok /
// failed / stalled branch on its own as soon as the run finishes.

export function RunningWatch({ enabled = true }: { enabled?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => router.refresh(), 15_000);
    return () => window.clearInterval(t);
  }, [enabled, router]);
  return null;
}
