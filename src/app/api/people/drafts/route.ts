// T4a (2026-11-13). The only API that writes `people_drafts`. Three
// methods: POST creates or updates (upsert by id when supplied),
// DELETE removes one id. GET is not provided - the page server-
// renders the current draft via loadDraft() on page load.
//
// HARDENING PASS (2026-11-13)
//
//   - module is NEVER read from the body; it is the constant "paf"
//     in this train. T4b + T4c will introduce `newhire` and
//     `incident` with their own routes (or an explicit server
//     allow-list added here).
//   - action_type must be one of the three sheets this train
//     supports or null; anything else is 400.
//   - payload is REBUILT server-side from a strict whitelist.
//     Unknown keys are dropped. Strings are trimmed; explanation
//     is capped at 2000 chars, everything else at 200. Requests
//     over 16 KB are 413.
//   - If payload.person_worker_id is present, the person must be
//     ACTIVE and in the viewer's scope (same inScope check the
//     /people/paf page uses for ?for=) OR the viewer themself.
//     employeeName / locationKey / locationName are then set
//     SERVER-SIDE from that person's row; `person_name` on the
//     draft row is set the same way. The body's values are
//     overridden.
//
// Preview guard: every write refuses when the session is operating
// under ?as= (owner preview). The viewer resolver fills
// `viewer.previewOf` with the real owner's identity when ?as= is
// active; we refuse on that signal here so nothing can write "on
// behalf of" the previewed worker.
//
// Owner filter: every write (create / update / delete) passes the
// signed-in viewer's lowercase work_email as owner_email through
// the helpers in src/lib/people/drafts.ts. An update / delete that
// names an id belonging to another owner is a no-op (0 rows).

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { inScope } from "@/lib/people/scope";
import { createDraft, updateDraft, deleteDraft } from "@/lib/people/drafts";
import type { PeopleRow, Viewer } from "@/lib/people/types";

export const dynamic = "force-dynamic";

// T4a hardening constants.
const MODULE_PAF = "paf" as const;
const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "add_bonus",
  "add_deduction",
  "add_gratuity",
]);
const PAYLOAD_KEYS = [
  "amount",
  "effectiveDate",
  "explanation",
  "employeeName",
  "locationKey",
  "locationName",
  "person_worker_id",
  "_v",
] as const;
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
  // Pin the draft to the signed-in viewer's roster work_email,
  // lower-cased. ?as= cannot change the owner here - the preview
  // guard refuses the write under preview anyway.
  return (viewer.work_email ?? "").trim().toLowerCase();
}

function trimCap(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

export interface SanitizedBody {
  action_type: string | null;
  payload: Record<string, unknown>;
  person_name: string | null;
}
export type SanitizeResult =
  | { ok: true; body: SanitizedBody }
  | { ok: false; status: 400 | 403 | 413; error: string };

// Validate + rewrite the request body. Everything server-authoritative
// after this function returns. Callers use `result.body`; nothing from
// the raw body reaches the DB untouched.
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

  // action_type whitelist. Null is allowed (the client may autosave
  // before the user picks an action); anything else 400.
  const rawAction = b.action_type;
  let action_type: string | null;
  if (rawAction === null || rawAction === undefined || rawAction === "") action_type = null;
  else if (typeof rawAction === "string" && VALID_ACTIONS.has(rawAction)) action_type = rawAction;
  else return { ok: false, status: 400, error: "action_type_not_allowed" };

  // payload whitelist. Rebuild from scratch.
  const incoming = (b.payload && typeof b.payload === "object")
    ? (b.payload as Record<string, unknown>)
    : {};
  const payload: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) {
    if (!(key in incoming)) continue;
    if (key === "_v") continue; // always set to the constant below
    if (key === "explanation") payload[key] = trimCap(incoming[key], EXPLANATION_MAX);
    else payload[key] = trimCap(incoming[key], STRING_MAX);
  }
  payload._v = 2; // schema version, server-authoritative

  let person_name: string | null = null;
  const pwid = typeof payload.person_worker_id === "string" ? payload.person_worker_id : "";
  if (pwid) {
    // Resolve + scope-check. Match the /people/paf page's scope
    // check (same inScope function, same accountRegionByKey shape).
    const personQ = await sb
      .from("people")
      .select(PEOPLE_SELECT)
      .eq("status", "ACTIVE")
      .eq("worker_id", pwid)
      .maybeSingle();
    const person = (personQ.data as PeopleRow | null) ?? null;
    if (!person) return { ok: false, status: 403, error: "person_not_active" };
    const accQ = await sb.from("accounts").select("team_key, region, name");
    const accountRegionByKey = new Map<string, string | null>();
    const accountNameByKey = new Map<string, string>();
    for (const a of accQ.data ?? []) {
      accountRegionByKey.set(a.team_key as string, (a.region as string | null) ?? null);
      accountNameByKey.set(a.team_key as string, ((a.name as string | null) ?? "").trim());
    }
    const isSelf = person.worker_id === viewer.worker_id;
    if (!isSelf && !inScope(viewer, person, accountRegionByKey)) {
      return { ok: false, status: 403, error: "person_out_of_scope" };
    }
    // Server-authoritative identity fields. Overrides anything the
    // body passed for these three keys.
    const displayName = (person.display_name ?? "").trim();
    payload.employeeName = displayName;
    payload.locationKey = person.account_key;
    payload.locationName = accountNameByKey.get(person.account_key) ?? "";
    person_name = displayName;
  } else {
    // No person set - keep employeeName / locationKey / locationName
    // empty. (The client never sends person-identity fields without
    // the worker_id, but strip them to be safe.)
    payload.employeeName = "";
    payload.locationKey = "";
    payload.locationName = "";
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

  // Read the raw body as text so we can enforce a size limit before
  // any parser allocates. 16 KB is enormous for our shape (~1.7 KB
  // in v1 today) and lets us reject accidental copy-paste payloads.
  const rawText = await req.text();
  const sanitized = await sanitizeBody(sb, viewer, rawText);
  if (!sanitized.ok) {
    return NextResponse.json({ error: sanitized.error }, { status: sanitized.status });
  }

  // Preserve the original id when the client sent one; the body text
  // was already parsed inside sanitizeBody, so we parse one more
  // time for the id alone. (id is an opaque string; no sanitising
  // beyond "is a string".)
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
  const ok = await deleteDraft(sb, owner, id);
  if (!ok) return new Response(null, { status: 404 });
  return new Response(null, { status: 204 });
}
