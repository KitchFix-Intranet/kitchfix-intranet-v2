"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import { fmtCount } from "@/lib/fmt";
import { postJson, saveErrorSentence } from "./panel/common";

type Props = { disabled?: boolean };

export function RunIntakeButton({ disabled = false }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const label = busy ? "Running" : disabled ? "Running" : "Run intake";

  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    // Long-job rule (train 2 §5 ruling 7): the "started" toast may
    // fire before the reply. If the reply never comes or fails, the
    // words below say so and the button comes back.
    toast("Intake started - this takes about three minutes");
    // No 30-second cap for intake - the server holds the connection
    // through about three minutes of work.
    const r = await postJson("/api/intake?mode=full", {}, { timeoutMs: null });
    if (!r.ok) {
      toast(saveErrorSentence(r) ?? "Nothing was saved.", { tone: "block" });
      setBusy(false);
      return;
    }
    const body = (r.data ?? {}) as { status?: string; counts?: Record<string, unknown> };
    if (body?.status === "failed") {
      toast("The server could not save this. Nothing was saved.", { tone: "block" });
      setBusy(false);
      return;
    }
    const counts = body.counts ?? {};
    const linesRead = Number((counts as Record<string, unknown>).lines_read ?? 0);
    const items = Number((counts as Record<string, unknown>).vendor_items_touched ?? 0);
    const twins = Number((counts as Record<string, unknown>).twins_found ?? 0);
    toast(
      `Intake finished: ${fmtCount(linesRead)} lines read, ${fmtCount(items)} items touched, ${fmtCount(twins)} twins`
    );
    router.refresh();
    setBusy(false);
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
