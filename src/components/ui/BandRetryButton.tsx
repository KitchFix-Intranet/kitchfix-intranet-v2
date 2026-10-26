"use client";

import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function BandRetryButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="kf-btn kf-btn--line-on-navy kf-btn--sm"
      onClick={() => router.refresh()}
    >
      <RefreshCw size={14} strokeWidth={1.5} />
      <span>Retry</span>
    </button>
  );
}
