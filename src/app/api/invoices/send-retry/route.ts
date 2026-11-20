// GET /api/invoices/send-retry
//
// Vercel cron fires this every 10 minutes (see vercel.json).
//
// §5 of train 3: claims up to 5 held rows whose
// email_next_attempt_at has passed and whose claim is empty or
// past, delivers each (through the same deliverSend the send
// route uses), and releases the claim. Switch off: does nothing
// and says so in the JSON.
//
// Correction 1: the claim is per row, not a single FOR UPDATE
// SKIP LOCKED statement. candidateIdsForRetry returns the
// shortlist; tryClaim per id wins the row only when the
// conditional UPDATE returns it. releaseClaim runs in a
// try/finally so a crash does not keep a row stuck.
//
// Correction 9: maxDuration = 60.

import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { outboundMode } from "@/lib/invoices/outboundGate";
import { mayDeliver } from "@/lib/invoices/mayDeliver";
import { candidateIdsForRetry, tryClaim, releaseClaim } from "@/lib/invoices/claim";
import { deliverSend, type DeliverResult } from "@/lib/invoices/deliverSend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isCronAuthorized(req)) return new Response(null, { status: 401 });

  const mode = outboundMode();
  if (mode === "off") {
    return NextResponse.json({ ok: true, switch: "off", claimed: 0, delivered: 0, held: 0, gave_up: 0 });
  }

  const sb = serviceClient();
  const now = new Date();
  const candidates = await candidateIdsForRetry(sb, now, 5);

  let claimed = 0, delivered = 0, held = 0, gaveUp = 0;
  for (const sendId of candidates) {
    const got = await tryClaim(sb, sendId, now);
    if (!got) continue;
    claimed += 1;
    try {
      const row = await readSendForDelivery(sb, sendId);
      if (!row) continue;
      // The row's own mode decides whether we can deliver under
      // the current switch. Correction 3.
      if (!mayDeliver(row.mode, mode)) {
        // Shouldn't happen (mode=off above; the retry fires in
        // test/live and mayDeliver respects both). Skip the row
        // and release the claim so the next tick can re-decide.
        continue;
      }
      const result: DeliverResult = await deliverSend({
        sb, sendId, invoiceId: row.submission_id,
        rowMode: row.mode, switchMode: mode,
      });
      if (result.kind === "delivered") delivered += 1;
      else if (result.kind === "gave_up") gaveUp += 1;
      else held += 1;
    } finally {
      await releaseClaim(sb, sendId);
    }
  }

  return NextResponse.json({ ok: true, switch: mode, claimed, delivered, held, gave_up: gaveUp });
}

async function readSendForDelivery(
  sb: ReturnType<typeof serviceClient>,
  sendId: string,
): Promise<{ submission_id: string; mode: "test" | "live" } | null> {
  const { data } = await sb
    .from("invoice_sends")
    .select("submission_id, mode")
    .eq("id", sendId)
    .maybeSingle();
  if (!data) return null;
  if (data.mode !== "test" && data.mode !== "live") return null;
  return { submission_id: data.submission_id, mode: data.mode };
}
