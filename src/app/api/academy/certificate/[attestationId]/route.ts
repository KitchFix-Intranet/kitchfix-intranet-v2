// /api/academy/certificate/[attestationId]
//
// Serves the Academy certificate PDF for one attestation. Browser-
// download endpoint (Content-Disposition: attachment).
//
// SECURITY MODEL
// A viewer may fetch an attestation IF:
//   1. They are the worker who signed it, OR
//   2. They hold the academy_admin grant.
// If neither, return 404 (never 403). The endpoint MUST NOT leak
// which attestation ids exist.

import { NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "@/lib/academy/identity";
import { createCertificatePdf } from "@/lib/academy/certificate";

export const dynamic = "force-dynamic";
// Pin the Node runtime: pdf-lib depends on Node streams / Buffer and
// the serverExternalPackages setting in next.config.ts only applies
// to functions on the Node runtime. A future default change to Edge
// would silently break certificate rendering; this makes the pin
// explicit at the route.
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function safeFilenameSegment(s: string, max = 80): string {
  const cleaned = String(s || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trim();
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ attestationId: string }> }
) {
  const g = await requireOwnerApi();
  if (g instanceof Response) return g;

  const { attestationId } = await ctx.params;
  if (!attestationId || !UUID_RE.test(attestationId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const supa = serviceClient();

  let identity;
  try {
    identity = await resolveAcademyIdentity(g.email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/academy/certificate] resolve threw:", msg);
    return NextResponse.json({ error: "server_error", scope: "identity" }, { status: 500 });
  }
  if (!identity) {
    return NextResponse.json({ error: "no_roster_row" }, { status: 404 });
  }

  const attQ = await supa
    .from("academy_attestations")
    .select(
      "attestation_id, worker_id, doc_id, obligation_key, doc_version, typed_name, signed_at, attempts_count, time_spent_seconds, certificate_serial, attestation_text"
    )
    .eq("attestation_id", attestationId)
    .maybeSingle();
  if (attQ.error) {
    console.error("[api/academy/certificate] attestation lookup:", attQ.error.message);
    return NextResponse.json({ error: "server_error", scope: "attestation" }, { status: 500 });
  }
  if (!attQ.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  type AttRow = {
    attestation_id: string;
    worker_id: string;
    doc_id: string;
    obligation_key: string;
    doc_version: string | number | null;
    typed_name: string | null;
    signed_at: string | null;
    attempts_count: number | null;
    time_spent_seconds: number | null;
    certificate_serial: string | null;
    attestation_text: string | null;
  };
  const attestation = attQ.data as AttRow;

  const isOwner = attestation.worker_id === identity.workerId;
  const isAdmin =
    Array.isArray(identity.grants) && identity.grants.includes("academy_admin");
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  type DocRow = {
    id: string;
    title: string | null;
    doc_class: string | null;
    version: string | number | null;
  };
  type OblRow = {
    doc_id: string;
    obligation_key: string;
    source_section: string | null;
  };
  let doc: DocRow | null = null;
  if (attestation.doc_id) {
    const docQ = await supa
      .from("documents")
      .select("id, title, doc_class, version")
      .eq("id", attestation.doc_id)
      .maybeSingle();
    if (docQ.error) {
      console.warn("[api/academy/certificate] doc lookup:", docQ.error.message);
    } else if (docQ.data) {
      doc = docQ.data as DocRow;
    }
  }

  let obligation: OblRow | null = null;
  if (attestation.doc_id && attestation.obligation_key) {
    const oblQ = await supa
      .from("academy_obligations")
      .select("doc_id, obligation_key, source_section")
      .eq("doc_id", attestation.doc_id)
      .eq("obligation_key", attestation.obligation_key)
      .maybeSingle();
    if (oblQ.error) {
      console.warn("[api/academy/certificate] obligation lookup:", oblQ.error.message);
    } else if (oblQ.data) {
      obligation = oblQ.data as OblRow;
    }
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await createCertificatePdf({ attestation, doc, obligation });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/academy/certificate] pdf gen threw:", msg);
    return NextResponse.json({ error: "server_error", scope: "pdf_gen" }, { status: 500 });
  }

  const serialPart = safeFilenameSegment(attestation.certificate_serial || "certificate", 40);
  const titlePart = safeFilenameSegment(doc?.title || attestation.doc_id || "module", 80);
  const filename = `${serialPart} ${titlePart}.pdf`.replace(/\s+/g, " ").trim();

  // Copy into a fresh ArrayBuffer so TypeScript sees a BodyInit-compatible
  // view. pdf-lib returns Uint8Array<ArrayBufferLike>, and the Fetch Response
  // type requires an ArrayBuffer-backed view.
  const bodyBuffer = new Uint8Array(pdfBytes);
  return new Response(bodyBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bodyBuffer.length),
      "Cache-Control": "private, no-store",
    },
  });
}
