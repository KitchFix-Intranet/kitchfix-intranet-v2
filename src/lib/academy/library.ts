// src/lib/academy/library.ts
//
// Loader for the Library bookcase (`/library`) and for
// `/api/academy/library`. One loader feeds every surface. L2 folds
// the old `loadLibrary` (shelves) and `loadLibraryIndex` (Find) into
// one function; the bookcase is one page now, so there is one shape
// of data behind it.
//
// READ-ONLY. No PII on the wire.
//
// Access
// ──────
// L1's rule stands: `resolveReaderLevel` + `canReadDocument` decide
// may-read, applied server-side BEFORE any count, shelf or search
// list is built. A restricted row never reaches the client payload
// for a viewer whose level is `reads_unrestricted`. See
// `src/lib/academy/access.ts`.
//
// Tile marks (R-AC26)
// ───────────────────
// Readers see no reading-level mark and no Academy mark. The three
// marks the bookcase surfaces are derived here so client code never
// has to look back at the raw DB fields:
//
//   has_es          - `true` when another live, readable document in
//                     the catalogue has this doc's id followed by
//                     `-ES`. Derived set-based; two-way-correct:
//                     POL-006 gets `has_es=true` iff POL-006-ES is
//                     present AND readable.
//   posted_on_wall  - mirrors `documents.print_required = true`.
//   filled_by_leader- OMITTED. No column in `documents` or
//                     `academy_obligations` encodes "a leader fills
//                     in this form" today; the spec says a missing
//                     datum is left out of the UI, not guessed.
//                     See L2 report / ACADEMY.md.
//
// No `trains_you` / `trainsYouCount`: the Library is a reading
// product (R-AC26) and neither the bookcase nor the document page
// shows an Academy mark. L1's parity probe may surface this as a
// diff from v1 - it is expected divergence.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";
import { resolveReaderLevel, canReadDocument } from "./access";

export type LibraryResult =
  | { ok: false; status: 500; error: string; scope: string }
  | ({ ok: true } & LibraryBody);

export interface LibraryDoc {
  id: string;
  title: string;
  card_line: string | null;
  summary: string | null;
  keywords: string[];
  version: string | number | null;
  updated_at: string | null;
  effective_date: string | null;
  doc_class: string | null;
  shelf: string | null;
  // Tile marks (derived; see header).
  has_es: boolean;
  posted_on_wall: boolean;
}

export interface LibraryBody {
  totalDocs: number;
  totalShelves: number;
  shelves: Array<{
    name: string;
    count: number;
    docs: LibraryDoc[];
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

export async function loadLibrary(
  email: string,
  supaIn?: SupabaseClient,
): Promise<LibraryResult> {
  const supa = supaIn || serviceClient();

  // Legitimately null for anyone off the roster; the Library still
  // renders in that case.
  let identity = null as Awaited<ReturnType<typeof resolveAcademyIdentity>>;
  try {
    identity = await resolveAcademyIdentity(email, { supa });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[academy/loadLibrary] identity resolve threw:", msg);
    identity = null;
  }

  // Live-only. GOTCHA 17: `documents.status` is title-case ("Live");
  // a lowercase comparison would silently return zero rows.
  const docsQ = await supa
    .from("documents")
    .select(
      "id, title, card_line, summary, keywords, version, shelf, doc_class, updated_at, effective_date, print_required, access_level",
    )
    .eq("status", "Live")
    .not("shelf", "is", null)
    .order("shelf", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (docsQ.error) {
    console.error("[academy/loadLibrary] documents:", docsQ.error.message);
    return { ok: false, status: 500, error: "server_error", scope: "documents" };
  }

  type DocRow = {
    id: string;
    title: string | null;
    card_line: string | null;
    summary: string | null;
    keywords: string[] | null;
    version: string | number | null;
    shelf: string | null;
    doc_class: string | null;
    updated_at: string | null;
    effective_date: string | null;
    print_required: boolean | null;
    access_level: string | null;
  };

  // L1 gate: filter server-side BEFORE any count, shelf or search
  // list is built. A restricted row never enters the payload for a
  // viewer whose level is `reads_unrestricted`.
  const level = resolveReaderLevel(email, identity);
  const allRows = (docsQ.data as DocRow[]) || [];
  const readable = allRows.filter((d) => canReadDocument(level, d.access_level));

  // Derive `has_es`: an id has a Spanish copy when `<id>-ES` is
  // present among READABLE rows. A restricted sibling never flips
  // the mark because it never enters `readable`.
  const readableIds = new Set(readable.map((d) => d.id));
  const hasEsFor = (id: string): boolean =>
    !id.endsWith("-ES") && readableIds.has(`${id}-ES`);

  const toDoc = (d: DocRow): LibraryDoc => ({
    id: d.id,
    title: d.title || d.id,
    card_line: d.card_line || null,
    summary: d.summary || null,
    keywords: Array.isArray(d.keywords) ? d.keywords : [],
    version: d.version ?? null,
    updated_at: d.updated_at ?? null,
    effective_date: d.effective_date ?? null,
    doc_class: d.doc_class || null,
    shelf: d.shelf || null,
    has_es: hasEsFor(d.id),
    posted_on_wall: d.print_required === true,
  });

  const byShelf = new Map<string, LibraryDoc[]>();
  for (const s of SHELF_ORDER) byShelf.set(s, []);
  const unknownShelves = new Map<string, LibraryDoc[]>();

  for (const d of readable) {
    const row = toDoc(d);
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
    const docs = byShelf.get(name) || [];
    // Empty shelves are not shown.
    if (docs.length === 0) continue;
    shelves.push({ name, count: docs.length, docs });
  }
  for (const [name, docs] of unknownShelves) {
    if (docs.length === 0) continue;
    shelves.push({ name: String(name), count: docs.length, docs });
  }

  return {
    ok: true,
    totalDocs: readable.length,
    totalShelves: shelves.length,
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
