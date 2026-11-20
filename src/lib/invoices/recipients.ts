// Invoices V2 - pure recipient resolver.
//
// One function decides every recipient list. The row's mode
// decides, not the switch: a row stored as mode='test' can never
// resolve to the AP address, no matter what the switch holds
// (correction 3, bullet 1).
//
// Missing env is a held invoice, not a silent reroute. In
// `live` without INVOICE_AP_TO_EMAIL, or in `test` without
// INVOICES_V2_TEST_TO, the resolver returns a missing_env code;
// the caller marks the invoice held with that code. Never falls
// back to another address.
//
// No email address appears in this file. Tests use `a@example.test`.

export type RowMode = "test" | "live";

export interface RecipientEnv {
  INVOICE_AP_TO_EMAIL?: string;
  INVOICES_V2_TEST_TO?: string;
  INVOICES_V2_CC?: string;
}

export type RecipientsResult =
  | { ok: true; to: string[]; cc: string[] }
  | { ok: false; code: "missing_env:INVOICE_AP_TO_EMAIL" | "missing_env:INVOICES_V2_TEST_TO" };

function cleanList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const s = piece.trim();
    if (s === "") continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function resolveRecipients(
  rowMode: RowMode,
  env: RecipientEnv,
  submitterEmail: string | null | undefined,
): RecipientsResult {
  if (rowMode === "test") {
    const to = (env.INVOICES_V2_TEST_TO ?? "").trim();
    if (!to) return { ok: false, code: "missing_env:INVOICES_V2_TEST_TO" };
    // In test mode: never any cc, and structurally cannot read
    // the AP env. The function does not look at
    // env.INVOICE_AP_TO_EMAIL on this branch.
    return { ok: true, to: [to], cc: [] };
  }
  // rowMode === "live"
  const to = (env.INVOICE_AP_TO_EMAIL ?? "").trim();
  if (!to) return { ok: false, code: "missing_env:INVOICE_AP_TO_EMAIL" };
  const cc: string[] = [];
  const sub = (submitterEmail ?? "").trim();
  if (sub !== "" && sub !== to) cc.push(sub);
  for (const extra of cleanList(env.INVOICES_V2_CC)) {
    if (extra !== to && !cc.includes(extra)) cc.push(extra);
  }
  return { ok: true, to: [to], cc };
}
