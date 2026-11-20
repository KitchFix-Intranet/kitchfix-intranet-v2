// Train 6: "a week was submitted on a site that does not bill
// through SC" owner notice. Kevin-only (ruling 2026-11-20). Fires
// from the submit-week route's `after()` block when the submit
// succeeded + the site is NOT billed. Billed sites already have the
// engine's N1 inside the push pipeline; this is the counterpart for
// the sites v1 did not notify about at all.
//
// Modes:
//   off   -> do nothing. The outbound seam itself refuses the send,
//            but we also short-circuit here so the log is quiet.
//   test  -> sends to Kevin with "[TEST] " subject prefix.
//   live  -> sends to Kevin (sole recipient; this is a no-invoice
//            site, so there is no AP / AR routing to do).
//
// Rules from Chat ruling 2026-11-20:
//   - The submitter is named from `people.display_name` (not their
//     email). "Someone" if the people row is missing.
//   - No dollars. A site with no invoice shows no dollars anywhere.
//   - Meals stay.
//
// Pure of side effects besides the one email. Never throws out of
// the `after()` block; errors are logged.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmailSA } from "@/lib/sc/outbound";
import { outboundMode } from "@/lib/sc/outboundGate";
import { KEVIN_EMAIL } from "@/lib/sc/billing/recipients";
import { _internals as qboInternals } from "@/lib/sc/billing/qboNotifications";
import { accountKeyToSlug } from "@/lib/sc/calendar/slug";
import { appBaseUrl } from "./appBaseUrl";

const { emailShell, escapeHtml, fmtWeekRange, EMAIL_SENDER, EMAIL_DISPLAY_NAME } = qboInternals;

export interface NoInvoiceNoticeInput {
  accountKey: string;
  siteName: string;
  weekStart: string;
  unitSpanDays: number;           // 7 or 14; drives the date range label
  totalMeals: number;
  submittedByName: string | null; // resolved from `people`; "Someone" fallback
}

export interface NoInvoiceNoticeResult {
  outcome: "mode_off" | "sent" | "failed";
  isTest: boolean;
  subject?: string;
}

export function buildNoInvoiceNotice(input: NoInvoiceNoticeInput, isTest: boolean) {
  const weekEndIso = addDaysIso(input.weekStart, input.unitSpanDays - 1);
  const dateRange = fmtWeekRange(input.weekStart, weekEndIso);
  const submitter = (input.submittedByName && input.submittedByName.trim()) || "Someone";
  const slug = accountKeyToSlug(input.accountKey);
  const q = new URLSearchParams({ site: slug, week: input.weekStart });
  const weekLink = `${appBaseUrl()}/service/review?${q.toString()}`;
  const subject = `${isTest ? "[TEST] " : ""}Week submitted · ${input.siteName} · ${dateRange} · on record only`;
  const preheader = `On record only - this site does not bill through the service calendar.`;
  const body = `
    <p style="margin:0 0 12px;font-size:14px;color:#111827;line-height:1.5"><b>${escapeHtml(input.siteName)}</b> submitted the week of ${escapeHtml(dateRange)}.</p>
    <p style="margin:0 0 12px;font-size:14px;color:#111827;line-height:1.5">${escapeHtml(submitter)} submitted. No invoice is sent; this site does not bill through the service calendar.</p>
    <p style="margin:0 0 12px;font-size:14px;color:#111827;line-height:1.5">Meals: ${input.totalMeals}</p>
    <a href="${escapeHtml(weekLink)}" style="display:block;text-align:center;padding:11px;background:#1A3050;color:#ffffff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700;margin:16px 0 0">Open the week</a>
  `;
  const html = emailShell({ preheader, body });
  return { subject, preheader, html };
}

export async function resolveSubmitterName(sb: SupabaseClient, email: string): Promise<string | null> {
  if (!email) return null;
  const { data, error } = await sb
    .from("people")
    .select("display_name")
    .eq("work_email", email.toLowerCase().trim())
    .maybeSingle();
  if (error) {
    console.error(`[sc/n1NoInvoice] resolveSubmitterName: ${error.message}`);
    return null;
  }
  const row = data as { display_name: string | null } | null;
  return row?.display_name ?? null;
}

export async function sendNoInvoiceNotice(input: NoInvoiceNoticeInput): Promise<NoInvoiceNoticeResult> {
  const mode = outboundMode();
  if (mode === "off") return { outcome: "mode_off", isTest: false };
  const isTest = mode === "test";
  const { subject, html } = buildNoInvoiceNotice(input, isTest);
  try {
    const r = await sendEmailSA({
      sender: EMAIL_SENDER,
      displayName: EMAIL_DISPLAY_NAME,
      to: [KEVIN_EMAIL],
      subject,
      html,
    });
    return { outcome: r, isTest, subject };
  } catch (e: unknown) {
    console.error(`[sc/n1NoInvoice] send threw: ${e instanceof Error ? e.message : String(e)}`);
    return { outcome: "failed", isTest, subject };
  }
}

function addDaysIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`addDaysIso: ${iso}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dd}`;
}
