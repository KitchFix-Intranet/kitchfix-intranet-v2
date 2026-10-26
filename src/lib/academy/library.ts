// src/lib/academy/library.ts
//
// Loader for /api/academy/library. Returns the active document
// catalogue grouped by shelf, plus the set of doc_ids whose
// obligations apply to THIS viewer (the "trains you" marker).
//
// READ-ONLY. No PII on the wire.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";

export type LibraryResult =
  | { ok: false; status: 500; error: string; scope: string }
  | ({ ok: true } & LibraryBody);

export interface LibraryBody {
  totalDocs: number;
  totalTrainsYou: number;
  shelves: Array<{
    name: string;
    count: number;
    trains_you_count: number;
    docs: Array<{
      id: string;
      title: string;
      card_line: string | null;
      version: string | number | null;
      updated_at: string | null;
      effective_date: string | null;
      doc_class: string | null;
      trains_you: boolean;
    }>;
  }>;
  viewer: {
    displayName: string | null;
    isSalaried: boolean;
    onRoster: boolean;
  };
}

const SHELF_ORDER = Object.freeze([
  "People & Conduct",
  "Service Delivery & Client Accounts",
  "Safety, Health & Incident",
  "Operations & Leadership",
  "Brand & Documentation Standards",
  "Culinary & Kitchen Operations",
]);

function obligationTrainsViewer(
  applies_to: unknown,
  viewerIsSalaried: boolean
): boolean {
  if (applies_to == null) return true;
  if (typeof applies_to === "string") {
    return applies_to === "company-wide";
  }
  if (typeof applies_to !== "object") return true;
  const wc = (applies_to as { worker_class?: string }).worker_class;
  if (wc == null) return true;
  if (wc === "all") return true;
  if (wc === "salaried") return !!viewerIsSalaried;
  if (wc === "hourly") return !viewerIsSalaried;
  return true;
}

export async function loadLibrary(email: string, supaIn?: SupabaseClient): Promise<LibraryResult> {
  const supa = supaIn || serviceClient();

  // Legitimately null for anyone off the roster; the Library still
  // renders in that case, just with no trains-you markers.
  let identity = null as Awaited<ReturnType<typeof resolveAcademyIdentity>>;
  try {
    identity = await resolveAcademyIdentity(email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[academy/loadLibrary] identity resolve threw:", msg);
    identity = null;
  }

  // Live-only. The documents table carries status values In Build,
  // Pending, Blocked, Placeholder and Retired alongside Live - 51 of
  // the 133 rows today. The Library is a learner surface; a document
  // that is not Live is not something a chef should be reading. Match
  // the string case EXACTLY: `documents.status` is title-case
  // ("Live"), and a lowercase comparison returns zero rows silently
  // because Postgres text equality is case-sensitive. See GOTCHA 14.
  // A later library_admin surface may widen this; D1 does not build
  // that.
  const [docsQ, obQ] = await Promise.all([
    supa
      .from("documents")
      .select("id, title, card_line, version, shelf, doc_class, updated_at, effective_date")
      .eq("status", "Live")
      .not("shelf", "is", null)
      .order("shelf", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true }),
    supa.from("academy_obligations").select("doc_id, applies_to"),
  ]);

  if (docsQ.error) {
    console.error("[academy/loadLibrary] documents:", docsQ.error.message);
    return { ok: false, status: 500, error: "server_error", scope: "documents" };
  }
  if (obQ.error) {
    console.error("[academy/loadLibrary] obligations:", obQ.error.message);
    return { ok: false, status: 500, error: "server_error", scope: "obligations" };
  }

  type DocRow = {
    id: string;
    title: string | null;
    card_line: string | null;
    version: string | number | null;
    shelf: string | null;
    doc_class: string | null;
    updated_at: string | null;
    effective_date: string | null;
  };
  type ObRow = { doc_id: string; applies_to: unknown };

  const docs = (docsQ.data as DocRow[]) || [];
  const obligations = (obQ.data as ObRow[]) || [];

  const viewerIsSalaried = !!(identity && identity.isSalaried);
  const trainsYou = new Set<string>();
  if (identity) {
    for (const ob of obligations) {
      if (obligationTrainsViewer(ob.applies_to, viewerIsSalaried)) {
        trainsYou.add(ob.doc_id);
      }
    }
  }

  type ShelfDoc = LibraryBody["shelves"][number]["docs"][number];
  const byShelf = new Map<string, ShelfDoc[]>();
  for (const s of SHELF_ORDER) byShelf.set(s, []);
  const unknownShelves = new Map<string, ShelfDoc[]>();

  for (const d of docs) {
    const row: ShelfDoc = {
      id: d.id,
      title: d.title || d.id,
      card_line: d.card_line || null,
      version: d.version || null,
      updated_at: d.updated_at || null,
      effective_date: d.effective_date || null,
      doc_class: d.doc_class || null,
      trains_you: trainsYou.has(d.id),
    };
    if (d.shelf && byShelf.has(d.shelf)) {
      byShelf.get(d.shelf)!.push(row);
    } else {
      const key = String(d.shelf ?? "(no shelf)");
      if (!unknownShelves.has(key)) unknownShelves.set(key, []);
      unknownShelves.get(key)!.push(row);
    }
  }

  const shelves: LibraryBody["shelves"] = [];
  for (const name of SHELF_ORDER) {
    const rows = byShelf.get(name) || [];
    shelves.push({
      name,
      count: rows.length,
      trains_you_count: rows.filter((r) => r.trains_you).length,
      docs: rows,
    });
  }
  for (const [name, rows] of unknownShelves) {
    shelves.push({
      name: String(name),
      count: rows.length,
      trains_you_count: rows.filter((r) => r.trains_you).length,
      docs: rows,
    });
  }

  return {
    ok: true,
    totalDocs: docs.length,
    totalTrainsYou: trainsYou.size,
    shelves,
    viewer: identity
      ? {
          displayName: identity.displayName,
          isSalaried: identity.isSalaried,
          onRoster: true,
        }
      : { displayName: null, isSalaried: false, onRoster: false },
  };
}
