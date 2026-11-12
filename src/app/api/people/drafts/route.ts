// T4a + T4b-1 + T4b-2 drafts API. The only API that writes
// `people_drafts`. Three methods: POST creates or updates, DELETE
// removes one id, and now T4b-2's DELETE also cascades through
// the Storage bucket (receipts attached to the draft). GET is not
// provided - the page server-renders the current draft via
// loadDraft() on page load.
//
// T4b-2 (2026-11-14) adds four actions and shifts to a PER-ACTION
// payload whitelist. A draft keeps only the keys that belong to
// its action (plus the identity + _v shared pair). Keys from a
// different action are dropped silently. Per-action compute for
// pay_increase (dollarIncrease + pctIncrease) and
// travel_reimbursement (totals + counts) runs on the server; the
// body's computed values are ignored.
//
// Owner filter + preview guard unchanged from T4a: every write
// is pinned to the signed-in viewer's lowercase work_email, and
// the write refuses when `viewer.previewOf !== null`.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { inScope } from "@/lib/people/scope";
import { createDraft, updateDraft, deleteDraft, loadDraft } from "@/lib/people/drafts";
import type { PeopleRow, Viewer } from "@/lib/people/types";
import { computeRateIncrease } from "@/lib/people/payBands";
import { computeTravelTotals, type PerDiemDay } from "@/lib/people/perDiem";
import { deleteDraftReceipts } from "@/lib/people/attachments";

export const dynamic = "force-dynamic";

const MODULE_PAF = "paf" as const;

// T4b-2 (2026-11-14). Twelve actions become selectable. Anything
// else: 400.
const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "add_bonus",
  "add_deduction",
  "add_gratuity",
  "add_cell_phone",
  "separation",
  "title_change",
  "status_change",
  "reclassification",
  "pay_increase",
  "travel_reimbursement",
  "other_reimbursement",
  "equipment_request",
]);

// Common identity + _v stored on every draft payload.
const IDENTITY_KEYS = [
  "employeeName", "locationKey", "locationName", "person_worker_id", "_v",
] as const;

// Per-action payload whitelist. A draft keeps only these keys
// (plus IDENTITY_KEYS and any server-computed keys below).
const ACTION_KEYS: Record<string, readonly string[]> = {
  add_bonus:            ["amount", "effectiveDate", "explanation"],
  add_deduction:        ["amount", "effectiveDate", "explanation"],
  add_gratuity:         ["amount", "effectiveDate", "explanation"],
  add_cell_phone:       ["amount", "cellFrequency", "effectiveDate"],
  separation:           ["effectiveDate", "lastDayWorked", "actionGroup", "separationReason", "rehireEligible", "explanation"],
  title_change:         ["effectiveDate", "oldTitle", "newTitle", "reclassChangeRate", "newRate", "explanation"],
  status_change:        ["effectiveDate", "statusChangeDirection", "explanation"],
  reclassification:     ["effectiveDate", "reclassFrom", "reclassTo", "reclassTitleChange", "oldTitle", "newTitle", "reclassChangeRate", "newRate", "explanation"],
  pay_increase:         [
    "effectiveDate", "increaseType", "employeeLevel", "role", "customRole",
    "oldRate", "newRate", "dollarIncrease", "pctIncrease",
    "eligSeasonComplete", "eligNoDiscipline", "eligCertsCurrent", "eligManagerApproved",
    "explanation",
  ],
  travel_reimbursement: [
    "travelStartDate", "travelEndDate",
    // v2 addition: per-day tier choices as an array.
    "perDiemDays",
    "travelSupplementEnabled",
    // Server-computed below; accepted from the body only so Check
    // can display them before the first save.
    "perDiem_noMeals", "perDiem_bkfstProvided", "perDiem_lunchProvided",
    "perDiem_dinnerProvided", "perDiem_bkfstLunch", "perDiem_bkfstDinner",
    "perDiem_lunchDinner", "perDiem_allMeals",
    "travelTotalDays", "perDiemTotal", "travelSupplementTotal", "travelGrandTotal",
    "explanation",
  ],
  other_reimbursement:  ["amount", "effectiveDate", "explanation"],
  equipment_request:    ["equipmentRequestType", "replacementReason", "confirmReported", "currentDeviceDetails", "equipmentShipTo", "equipmentNotes", "confirmReturn", "explanation"],
};

// Actions where the server owns Current role (`oldTitle` on the
// payload). Overrides anything the body sent.
const TITLE_SERVER_AUTH: ReadonlySet<string> = new Set([
  "title_change",
  "reclassification",
]);

// Actions where locationKey + locationName come from the PERSON's
// own account (every T4a + T4b-1 action). For travel the
// locationKey + locationName are the SITE VISITED, not the person's
// site; the server validates them against `accounts` and leaves
// them in the payload.
const PERSON_SITE_ACTIONS: ReadonlySet<string> = new Set([
  "add_bonus", "add_deduction", "add_gratuity", "add_cell_phone",
  "separation", "title_change", "status_change", "reclassification",
  "pay_increase", "other_reimbursement", "equipment_request",
]);

const BODY_MAX_BYTES = 16 * 1024;
const EXPLANATION_MAX = 2000;
const STRING_MAX = 200;

const PEOPLE_SELECT =
  "worker_id, display_name, title, account_key, region, work_email, manager_worker_id, is_corp, is_salaried, is_site_leader, is_regional_director, pp_full_access, pp_review, status";

async function sessionViewer(asWorkerId: string | null) {
  const gated = await requireOwnerApi();
  if (gated instanceof Response) return { response: gated as Response };
  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, gated.email, asWorkerId, /* isOwner */ true);
  if (!viewer) return { response: new Response(null, { status: 404 }) };
  return { sb, viewer };
}

function ownerEmailFor(viewer: Viewer): string {
  return (viewer.work_email ?? "").trim().toLowerCase();
}

function trimCap(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// Normalise a perDiemDays array from the body. Each entry must
// have a YYYY-MM-DD date and a known tier key; anything else is
// dropped.
const PER_DIEM_TIER_KEYS = new Set([
  "noMeals", "bkfstProvided", "lunchProvided", "dinnerProvided",
  "bkfstLunch", "bkfstDinner", "lunchDinner", "allMeals",
]);
function normalisePerDiemDays(raw: unknown): PerDiemDay[] {
  if (!Array.isArray(raw)) return [];
  const out: PerDiemDay[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const d = String((row as Record<string, unknown>).date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const t = String((row as Record<string, unknown>).tier ?? "");
    if (t && !PER_DIEM_TIER_KEYS.has(t)) continue;
    out.push({ date: d, tier: t });
    if (out.length > 31) break;
  }
  return out;
}

export interface SanitizedBody {
  action_type: string | null;
  payload: Record<string, unknown>;
  person_name: string | null;
}
export type SanitizeResult =
  | { ok: true; body: SanitizedBody }
  | { ok: false; status: 400 | 403 | 413; error: string };

export async function sanitizeBody(
  sb: SupabaseClient,
  viewer: Viewer,
  rawText: string,
): Promise<SanitizeResult> {
  if (rawText.length > BODY_MAX_BYTES) return { ok: false, status: 413, error: "body_too_large" };

  let body: unknown;
  try { body = JSON.parse(rawText || "{}"); }
  catch { return { ok: false, status: 400, error: "bad_json" }; }
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "bad_body" };
  const b = body as Record<string, unknown>;

  const rawAction = b.action_type;
  let action_type: string | null;
  if (rawAction === null || rawAction === undefined || rawAction === "") action_type = null;
  else if (typeof rawAction === "string" && VALID_ACTIONS.has(rawAction)) action_type = rawAction;
  else return { ok: false, status: 400, error: "action_type_not_allowed" };

  const incoming = (b.payload && typeof b.payload === "object")
    ? (b.payload as Record<string, unknown>)
    : {};

  // Pick the per-action allow-list. When no action is chosen yet
  // the draft can only carry the identity + _v fields.
  const actionKeys = action_type ? ACTION_KEYS[action_type] ?? [] : [];
  const keep = new Set<string>([...IDENTITY_KEYS, ...actionKeys]);

  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(incoming)) {
    if (!keep.has(key)) continue; // T4b-2: silent drop
    if (key === "_v") continue;
    if (key === "explanation") payload[key] = trimCap(incoming[key], EXPLANATION_MAX);
    else if (key === "perDiemDays") payload[key] = normalisePerDiemDays(incoming[key]);
    else payload[key] = trimCap(incoming[key], STRING_MAX);
  }
  payload._v = 2;

  let person_name: string | null = null;
  const pwid = typeof payload.person_worker_id === "string" ? payload.person_worker_id : "";
  if (pwid) {
    const personQ = await sb
      .from("people")
      .select(PEOPLE_SELECT)
      .eq("status", "ACTIVE")
      .eq("worker_id", pwid)
      .maybeSingle();
    const person = (personQ.data as PeopleRow | null) ?? null;
    if (!person) return { ok: false, status: 403, error: "person_not_active" };
    const accQ = await sb.from("accounts").select("team_key, region, name, state, active");
    const accountRegionByKey = new Map<string, string | null>();
    const accountNameByKey = new Map<string, string>();
    const accountActive = new Map<string, boolean>();
    for (const a of accQ.data ?? []) {
      accountRegionByKey.set(a.team_key as string, (a.region as string | null) ?? null);
      accountNameByKey.set(a.team_key as string, ((a.name as string | null) ?? "").trim());
      accountActive.set(a.team_key as string, a.active !== false);
    }
    const isSelf = person.worker_id === viewer.worker_id;
    if (!isSelf && !inScope(viewer, person, accountRegionByKey)) {
      return { ok: false, status: 403, error: "person_out_of_scope" };
    }
    const displayName = (person.display_name ?? "").trim();
    payload.employeeName = displayName;
    person_name = displayName;

    // Identity site rules. Most actions overwrite locationKey +
    // locationName with the PERSON's own account. Travel is
    // different: the viewer picks the SITE VISITED, so the server
    // validates the body's value and leaves it in the payload.
    if (action_type && PERSON_SITE_ACTIONS.has(action_type)) {
      payload.locationKey = person.account_key;
      payload.locationName = accountNameByKey.get(person.account_key) ?? "";
    } else if (action_type === "travel_reimbursement") {
      const chosenKey = String(payload.locationKey ?? "").trim();
      if (chosenKey) {
        if (!accountActive.get(chosenKey)) {
          return { ok: false, status: 400, error: "travel_site_not_active" };
        }
        payload.locationName = accountNameByKey.get(chosenKey) ?? "";
      }
    } else {
      payload.locationKey = "";
      payload.locationName = "";
    }

    // Server-authoritative Current role.
    if (action_type && TITLE_SERVER_AUTH.has(action_type)) {
      payload.oldTitle = (person.title ?? "").trim();
    } else {
      delete payload.oldTitle;
    }

    // Reclassification account check (From / To / not equal).
    if (action_type === "reclassification") {
      const activeTeamKeys = new Set<string>();
      for (const [tk, active] of accountActive.entries()) if (active) activeTeamKeys.add(tk);
      if (payload.reclassFrom && !activeTeamKeys.has(payload.reclassFrom as string)) {
        return { ok: false, status: 400, error: "reclassFrom_not_active" };
      }
      if (payload.reclassTo && !activeTeamKeys.has(payload.reclassTo as string)) {
        return { ok: false, status: 400, error: "reclassTo_not_active" };
      }
      if (payload.reclassFrom && payload.reclassFrom === payload.reclassTo) {
        return { ok: false, status: 400, error: "reclass_same_account" };
      }
    }

    // T4b-2: Pay increase computed fields (dollarIncrease, pctIncrease).
    if (action_type === "pay_increase") {
      const { dollarIncrease, pctIncrease } = computeRateIncrease(
        String(payload.oldRate ?? ""),
        String(payload.newRate ?? ""),
      );
      payload.dollarIncrease = dollarIncrease;
      payload.pctIncrease = pctIncrease;
    }

    // T4b-2: Travel totals recomputed from the dates + per-day
    // choices + supplement switch. The body's totals are ignored.
    if (action_type === "travel_reimbursement") {
      const totals = computeTravelTotals({
        startISO: String(payload.travelStartDate ?? ""),
        endISO: String(payload.travelEndDate ?? ""),
        perDiemDays: Array.isArray(payload.perDiemDays) ? payload.perDiemDays as PerDiemDay[] : [],
        supplementEnabled: String(payload.travelSupplementEnabled ?? "") === "Yes",
      });
      for (const [k, v] of Object.entries(totals)) payload[k] = v;
    }
  } else {
    payload.employeeName = "";
    payload.locationKey = "";
    payload.locationName = "";
    delete payload.oldTitle;
  }

  return { ok: true, body: { action_type, payload, person_name } };
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const asWorkerId = url.searchParams.get("as");
  const got = await sessionViewer(asWorkerId);
  if (got.response) return got.response;
  const { sb, viewer } = got;
  if (viewer.previewOf !== null) {
    return NextResponse.json({ error: "preview_no_write" }, { status: 403 });
  }
  const owner = ownerEmailFor(viewer);
  if (!owner) return new Response(null, { status: 400 });

  const rawText = await req.text();
  const sanitized = await sanitizeBody(sb, viewer, rawText);
  if (!sanitized.ok) {
    return NextResponse.json({ error: sanitized.error }, { status: sanitized.status });
  }

  let id: string | null = null;
  try {
    const parsed = JSON.parse(rawText || "{}") as Record<string, unknown>;
    if (typeof parsed.id === "string" && parsed.id.length > 0 && parsed.id.length <= 64) id = parsed.id;
  } catch { /* already caught by sanitizeBody */ }

  if (id) {
    const row = await updateDraft(sb, owner, id, {
      action_type: sanitized.body.action_type,
      person_name: sanitized.body.person_name,
      payload: sanitized.body.payload,
    });
    if (!row) return new Response(null, { status: 404 });
    return NextResponse.json({ draft: row });
  }

  const row = await createDraft(sb, {
    owner_email: owner,
    module: MODULE_PAF,
    action_type: sanitized.body.action_type,
    person_name: sanitized.body.person_name,
    payload: sanitized.body.payload,
  });
  if (!row) return new Response(null, { status: 500 });
  return NextResponse.json({ draft: row }, { status: 201 });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const asWorkerId = url.searchParams.get("as");
  const got = await sessionViewer(asWorkerId);
  if (got.response) return got.response;
  const { sb, viewer } = got;
  if (viewer.previewOf !== null) {
    return NextResponse.json({ error: "preview_no_write" }, { status: 403 });
  }
  const owner = ownerEmailFor(viewer);
  const id = url.searchParams.get("id");
  if (!owner || !id) return new Response(null, { status: 400 });

  // T4b-2 (2026-11-14). Discard = delete receipts first, then the
  // draft row. people_attachments cascade on delete, but the
  // Storage bucket does not, so we clean up objects explicitly.
  // When a receipt delete fails the draft row is kept and the
  // caller gets 500 - a half-deleted draft is worse than a kept
  // one.
  const draft = await loadDraft(sb, owner, id);
  if (!draft) return new Response(null, { status: 404 });
  try {
    await deleteDraftReceipts(sb, owner, id);
  } catch {
    return NextResponse.json({ error: "receipts_delete_failed" }, { status: 500 });
  }
  const ok = await deleteDraft(sb, owner, id);
  if (!ok) return new Response(null, { status: 404 });
  return new Response(null, { status: 204 });
}
