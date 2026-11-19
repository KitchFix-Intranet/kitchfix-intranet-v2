// GL codes for a site + usual-codes payload. Server.
//
// Load:
//   - every active gl_code for the site;
//   - the last 10 counting invoices for this (site, vendor) pair;
//   - compute `codes` + `singleCodeFill` via usualCodes.ts.
//
// "Counting" = §5 list filter (not in deleted/corrected/archived).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GlLine } from "./types";
import { computeUsualCodes, type UsualCode } from "./usualCodes";

export interface SiteGlCode {
  code: string;
  name: string;
  category: string | null;
  is_purchasing: boolean;
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

export async function loadUsualCodes(
  sb: SupabaseClient,
  accountKey: string,
  vendorId: string,
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
  return computeUsualCodes(past);
}
