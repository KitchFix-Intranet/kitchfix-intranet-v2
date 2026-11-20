// GL codes for a site + usual-codes payload. Server.
//
// Load:
//   - every active PURCHASING gl_code for the site (train 2b
//     correction 4.1: Ready check and the code pickers only ever
//     consider is_purchasing=true codes; income / wages / utilities
//     are filtered out);
//   - the last 10 counting invoices for this (site, vendor) pair;
//   - compute `codes` + `singleCodeFill` via usualCodes.ts, then
//     drop usual codes that are not in the site's active-purchasing
//     set so the UI never offers a chip the Ready check would reject.
//
// "Counting" = §5 list filter (not in deleted/corrected/archived).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GlLine } from "./types";
import { computeUsualCodes, type UsualCode } from "./usualCodes";

export interface SiteGlCode {
  code: string;
  name: string;
  category: string | null;
  is_purchasing: boolean;             // always true in results
}

export async function loadActiveCodesForSite(
  sb: SupabaseClient,
  accountKey: string,
): Promise<SiteGlCode[]> {
  const q = await sb
    .from("gl_codes")
    .select("code, name, category, is_purchasing")
    .eq("account_key", accountKey)
    .eq("active", true)
    .eq("is_purchasing", true)
    .order("code");
  if (q.error) return [];
  return ((q.data ?? []) as SiteGlCode[]);
}

export async function activeCodesSetForSite(
  sb: SupabaseClient,
  accountKey: string,
): Promise<Set<string>> {
  const rows = await loadActiveCodesForSite(sb, accountKey);
  return new Set(rows.map((r) => r.code));
}

export interface UsualCodesPayload {
  codes: UsualCode[];
  singleCodeFill: UsualCode | null;
  sampleSize: number;
}

// Loads the last 10 counting invoices for (site, vendor), computes
// usual codes, then filters both `codes` and `singleCodeFill`
// through the active-purchasing set. The sample size is unchanged -
// a historical invoice with a now-non-purchasing code still counts
// for the 10, but the code does not appear as an offered chip.
export async function loadUsualCodes(
  sb: SupabaseClient,
  accountKey: string,
  vendorId: string,
  activeSet?: ReadonlySet<string>,
): Promise<UsualCodesPayload> {
  const q = await sb
    .from("invoice_submissions")
    .select("total_amount, gl_breakdown")
    .eq("account_key", accountKey)
    .eq("vendor_id", vendorId)
    .not("status", "in", "(deleted,corrected,archived)")
    .order("submitted_at", { ascending: false })
    .limit(10);
  if (q.error) return { codes: [], singleCodeFill: null, sampleSize: 0 };

  const rows = ((q.data ?? []) as Array<{ total_amount: number | string | null; gl_breakdown: unknown }>);
  const past = rows.map((r) => ({
    total_amount: typeof r.total_amount === "number" ? r.total_amount : r.total_amount != null ? Number(r.total_amount) : null,
    gl_breakdown: Array.isArray(r.gl_breakdown) ? (r.gl_breakdown as GlLine[]) : [],
  }));
  const raw = computeUsualCodes(past);
  if (!activeSet) return raw;
  return filterUsualByActiveSet(raw, activeSet);
}

// Pure. Drops any code or singleCodeFill whose code is not in the
// active-purchasing set for the site. Preserves sampleSize (a
// historical invoice still "counts" even if its code has since been
// marked non-purchasing).
export function filterUsualByActiveSet(
  payload: UsualCodesPayload,
  activeSet: ReadonlySet<string>,
): UsualCodesPayload {
  const codes = payload.codes.filter((c) => activeSet.has(c.code));
  const singleCodeFill = payload.singleCodeFill && activeSet.has(payload.singleCodeFill.code)
    ? payload.singleCodeFill
    : null;
  return { codes, singleCodeFill, sampleSize: payload.sampleSize };
}
