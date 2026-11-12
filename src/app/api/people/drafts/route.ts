// T4a (2026-11-13). The only API that writes `people_drafts`. Three
// methods: POST creates or updates (upsert by id when supplied),
// DELETE removes one id. GET is not provided - the page server-
// renders the current draft via loadDraft() on page load.
//
// Preview guard: every write refuses when the session is operating
// under ?as= (owner preview). The viewer resolver already fills
// `viewer.previewOf` with the real owner's identity when ?as= is
// active; we refuse on that signal here so nothing can write "on
// behalf of" the previewed worker.
//
// Owner filter: every write (create / update / delete) passes the
// signed-in viewer's lowercase work_email as owner_email through
// the helpers in src/lib/people/drafts.ts. An update / delete that
// names an id belonging to another owner is a no-op (0 rows).

import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveViewer } from "@/lib/people/viewer";
import { createDraft, updateDraft, deleteDraft } from "@/lib/people/drafts";

export const dynamic = "force-dynamic";

async function sessionViewer(asWorkerId: string | null) {
  const gated = await requireOwnerApi();
  if (gated instanceof Response) return { response: gated as Response };
  const sb = serviceClient();
  const { viewer } = await resolveViewer(sb, gated.email, asWorkerId, /* isOwner */ true);
  if (!viewer) return { response: new Response(null, { status: 404 }) };
  return { sb, viewer };
}

function ownerEmailFor(viewer: Awaited<ReturnType<typeof resolveViewer>>["viewer"]): string {
  // Pin the draft to the signed-in viewer's roster work_email,
  // lower-cased. Never lets ?as= change the owner (the preview
  // guard below refuses the write regardless).
  return (viewer?.work_email ?? "").trim().toLowerCase();
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const asWorkerId = url.searchParams.get("as");
  const got = await sessionViewer(asWorkerId);
  if (got.response) return got.response;
  const { sb, viewer } = got;
  // PREVIEW GUARD. `viewer.previewOf !== null` whenever ?as= is
  // active - the resolver fills that field with the real owner's
  // identity. Any write under preview returns 403, so an owner
  // cannot create / autosave a draft "as" another worker.
  if (viewer.previewOf !== null) {
    return NextResponse.json({ error: "preview_no_write" }, { status: 403 });
  }
  const owner = ownerEmailFor(viewer);
  if (!owner) return new Response(null, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    module?: string;
    action_type?: string | null;
    person_name?: string | null;
    payload?: Record<string, unknown>;
  };

  if (body.id) {
    const row = await updateDraft(sb, owner, String(body.id), {
      action_type: body.action_type,
      person_name: body.person_name,
      payload: body.payload,
    });
    if (!row) return new Response(null, { status: 404 });
    return NextResponse.json({ draft: row });
  }

  const mod = (body.module ?? "paf").trim() || "paf";
  const row = await createDraft(sb, {
    owner_email: owner,
    module: mod,
    action_type: body.action_type ?? null,
    person_name: body.person_name ?? null,
    payload: body.payload ?? {},
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
