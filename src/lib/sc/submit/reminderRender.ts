// Train 6: Friday + Monday reminder email composers. Reuses the
// engine's `emailShell` + `escapeHtml` for the frame (one visual
// register across every SC send) and the engine's `fmtWeekRange`
// so the date label is identical to N1 / N2 / N3's.
//
// Every substitution - site name, greeting, RD first name, dates -
// is escaped before inserting into the HTML.
//
// Pure. The orchestration calls this and hands the result to the
// sender; tests pin the strings directly.

import { _internals as qboInternals } from "@/lib/sc/billing/qboNotifications";
import { reminderGreeting } from "./reminderGreeting";

const { emailShell, escapeHtml, fmtWeekRange } = qboInternals;

export type ReminderKind = "friday" | "monday";

export interface ReminderComposeInput {
  kind: ReminderKind;
  siteName: string;              // escaped before use
  leaderDisplayNames: Array<string | null>;
  weekStartIso: string;          // ISO date
  weekEndIso: string;            // ISO date (Sun for weekly, Sun of the pair for biweekly)
  isBiweekly: boolean;
  isBilled: boolean;             // Monday copy branches on this
  rdFirstName: string | null;    // single-RD case; null means multi-RD or none
  rdCount: number;               // 0 -> "tell the office"; 1 -> name; >1 -> no name
  scWeekLink: string;            // already built by scWeekFinalize's builder
  isTest: boolean;               // prefixes subject with "[TEST] "
}

export interface ReminderComposed {
  subject: string;
  preheader: string;
  html: string;
  text: string;                  // plain-text fallback
}

// ─── Subject line ───────────────────────────────────────────────

function subjectFor(input: ReminderComposeInput): string {
  const prefix = input.isTest ? "[TEST] " : "";
  if (input.kind === "friday") {
    return `${prefix}This week at ${input.siteName} is ready to check and submit`;
  }
  return `${prefix}Last week at ${input.siteName} is still open`;
}

// ─── Trailer line ("If something is in the way…") ──────────────

function trailerLine(rdCount: number, rdFirstName: string | null): string {
  if (rdCount === 0) return "If something is in the way, tell the office.";
  if (rdCount === 1 && rdFirstName) {
    return `If something is in the way, tell ${escapeHtml(rdFirstName)}.`;
  }
  return "If something is in the way, tell your regional director.";
}

function trailerLinePlain(rdCount: number, rdFirstName: string | null): string {
  if (rdCount === 0) return "If something is in the way, tell the office.";
  if (rdCount === 1 && rdFirstName) {
    return `If something is in the way, tell ${rdFirstName}.`;
  }
  return "If something is in the way, tell your regional director.";
}

// ─── Button ────────────────────────────────────────────────────

function buttonHtml(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" style="display:block;text-align:center;padding:12px;background:#1A3050;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;margin:16px 0 12px">${escapeHtml(label)}</a>`;
}

// ─── Friday body ───────────────────────────────────────────────

function fridayBodyHtml(input: ReminderComposeInput): string {
  const greeting = reminderGreeting(input.leaderDisplayNames);
  const unitWord = input.isBiweekly ? "These two weeks" : "This week";
  const sinceLabel = input.isBiweekly ? "them" : "it";
  const unitVerb = input.isBiweekly ? "have" : "has";
  const readLabel = input.isBiweekly ? "them through and submit them" : "it through and submit it";
  const dateRange = fmtWeekRange(input.weekStartIso, input.weekEndIso);
  void sinceLabel;
  return `
    <p style="margin:0 0 12px;font-size:14px;color:#111827;font-weight:700">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 12px;font-size:14px;color:#111827;line-height:1.5">${unitWord} (${escapeHtml(dateRange)}) at <b>${escapeHtml(input.siteName)}</b> ${unitVerb} not been submitted yet. ${input.isBiweekly ? "They are" : "It is"} due Sunday at 6 PM Central.</p>
    <p style="margin:0 0 12px;font-size:14px;color:#111827;line-height:1.5">When your numbers are in, read ${readLabel}.</p>
    ${buttonHtml(input.isBiweekly ? "Check and submit these two weeks" : "Check and submit this week", input.scWeekLink)}
    <p style="margin:12px 0 0;font-size:13px;color:#64748B;line-height:1.5">If the client has not confirmed the weekend yet, submit once they have.</p>
  `;
}

function fridayBodyText(input: ReminderComposeInput): string {
  const greeting = reminderGreeting(input.leaderDisplayNames);
  const unitWord = input.isBiweekly ? "These two weeks" : "This week";
  const unitVerb = input.isBiweekly ? "have" : "has";
  const dueWord = input.isBiweekly ? "They are" : "It is";
  const readLabel = input.isBiweekly ? "them through and submit them" : "it through and submit it";
  const dateRange = fmtWeekRange(input.weekStartIso, input.weekEndIso);
  return [
    greeting,
    "",
    `${unitWord} (${dateRange}) at ${input.siteName} ${unitVerb} not been submitted yet. ${dueWord} due Sunday at 6 PM Central.`,
    "",
    `When your numbers are in, read ${readLabel}.`,
    "",
    input.isBiweekly ? "Check and submit these two weeks:" : "Check and submit this week:",
    input.scWeekLink,
    "",
    "If the client has not confirmed the weekend yet, submit once they have.",
  ].join("\n");
}

// ─── Monday body ───────────────────────────────────────────────

function mondayBodyHtml(input: ReminderComposeInput): string {
  const greeting = reminderGreeting(input.leaderDisplayNames);
  const unitWord = input.isBiweekly ? "The last two weeks" : "Last week";
  const unitVerb = input.isBiweekly ? "have" : "has";
  const checkLabel = input.isBiweekly ? "them" : "it";
  const submitLabel = input.isBiweekly ? "submit them" : "submit it";
  const dateRange = fmtWeekRange(input.weekStartIso, input.weekEndIso);
  const billedLine = input.isBilled
    ? `Accounting reviews today and invoices go out Tuesday, so please check ${checkLabel} and ${submitLabel} this morning.`
    : `Please check ${checkLabel} and ${submitLabel} this morning so ${input.isBiweekly ? "they are" : "it is"} on record.`;
  return `
    <p style="margin:0 0 12px;font-size:14px;color:#111827;font-weight:700">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 12px;font-size:14px;color:#111827;line-height:1.5">${unitWord} (${escapeHtml(dateRange)}) at <b>${escapeHtml(input.siteName)}</b> ${unitVerb} not been submitted.</p>
    <p style="margin:0 0 12px;font-size:14px;color:#111827;line-height:1.5">${escapeHtml(billedLine)}</p>
    ${buttonHtml(input.isBiweekly ? "Check and submit these two weeks" : "Check and submit last week", input.scWeekLink)}
    <p style="margin:12px 0 0;font-size:13px;color:#64748B;line-height:1.5">${trailerLine(input.rdCount, input.rdFirstName)}</p>
  `;
}

function mondayBodyText(input: ReminderComposeInput): string {
  const greeting = reminderGreeting(input.leaderDisplayNames);
  const unitWord = input.isBiweekly ? "The last two weeks" : "Last week";
  const unitVerb = input.isBiweekly ? "have" : "has";
  const checkLabel = input.isBiweekly ? "them" : "it";
  const submitLabel = input.isBiweekly ? "submit them" : "submit it";
  const dateRange = fmtWeekRange(input.weekStartIso, input.weekEndIso);
  const billedLine = input.isBilled
    ? `Accounting reviews today and invoices go out Tuesday, so please check ${checkLabel} and ${submitLabel} this morning.`
    : `Please check ${checkLabel} and ${submitLabel} this morning so ${input.isBiweekly ? "they are" : "it is"} on record.`;
  return [
    greeting,
    "",
    `${unitWord} (${dateRange}) at ${input.siteName} ${unitVerb} not been submitted.`,
    "",
    billedLine,
    "",
    input.isBiweekly ? "Check and submit these two weeks:" : "Check and submit last week:",
    input.scWeekLink,
    "",
    trailerLinePlain(input.rdCount, input.rdFirstName),
  ].join("\n");
}

// ─── Entry point ───────────────────────────────────────────────

export function composeReminder(input: ReminderComposeInput): ReminderComposed {
  const subject = subjectFor(input);
  const preheader = input.kind === "friday"
    ? (input.isBiweekly
        ? `These two weeks at ${input.siteName} have not been submitted yet.`
        : `This week at ${input.siteName} is not submitted yet.`)
    : (input.isBiweekly
        ? `The last two weeks at ${input.siteName} are still open.`
        : `Last week at ${input.siteName} is still open.`);
  const body = input.kind === "friday"
    ? fridayBodyHtml(input)
    : mondayBodyHtml(input);
  const html = emailShell({ preheader, body });
  const text = input.kind === "friday"
    ? fridayBodyText(input)
    : mondayBodyText(input);
  return { subject, preheader, html, text };
}
