"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";

type Props = { disabled?: boolean };

export function RunIntakeButton({ disabled = false }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const label = busy ? "Running" : disabled ? "Running" : "Run intake";

  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    toast("Intake started - this takes about three minutes");
    try {
      const res = await fetch("/api/intake?mode=full", { method: "POST" });
      if (res.status === 401) {
        toast("You are signed out. Reload and try again.", { tone: "block" });
        return;
      }
      if (res.status === 404) {
        toast("Not permitted.", { tone: "block" });
        return;
      }
      const body = await res.json();
      if (!res.ok || body?.status === "failed") {
        toast(body?.note ?? `Intake failed (${res.status})`, { tone: "block" });
        return;
      }
      const counts = body.counts ?? {};
      const linesRead = Number(counts.lines_read ?? 0);
      const items = Number(counts.vendor_items_touched ?? 0);
      const twins = Number(counts.twins_found ?? 0);
      toast(
        `Intake finished: ${fmtCount(linesRead)} lines read, ${fmtCount(items)} items touched, ${fmtCount(twins)} twins`
      );
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: "block" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`kf-btn kf-btn--line kf-btn--sm${busy ? " is-busy" : ""}`}
      onClick={run}
      disabled={busy || disabled}
      aria-label={label}
    >
      <RefreshCw size={14} strokeWidth={1.5} />
      <span>{label}</span>
    </button>
  );
}
