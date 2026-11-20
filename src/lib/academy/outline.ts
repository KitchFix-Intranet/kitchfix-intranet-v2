// src/lib/academy/outline.ts
//
// One server-side source of truth for a document's section outline.
// The page uses it to render the Contents list + inject `id=` on
// each heading; the write route uses it to answer "is this
// section_key a real section of this document" and to look up the
// section_title to store on the issue row (the client never writes
// the title - a malicious client cannot rename a section by sending
// a suggestion). The owner's list uses the same slug rule so the
// section reference round-trips.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { resolveAcademyIdentity } from "./identity";
import { resolveReaderLevel, canReadDocument } from "./access";

// Pre-rendered Library HTML uses <h1>, <h2>, <h3> on sections.
const HEADING_RE = /<h([1-3])[^>]*>([^<]+)<\/h\1>/gi;

export type OutlineItem = { level: number; text: string; anchor: string };

export function decodeEntities(s: string): string {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function slugAnchor(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Strip a stored leading <h1> that just repeats the document title.
// Shared with the page so the Contents list and the body both agree
// on which heading starts the article (R-AC27 counter).
export function stripLeadingTitleH1(html: string, title: string): string {
  if (!html) return html;
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
  const m = re.exec(html);
  if (!m) return html;
  const inner = m[1].replace(/<[^>]*>/g, "").trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm(inner) !== norm(title)) return html;
  return html.replace(re, "");
}

// Build an outline + inject stable ids on every heading. Duplicate
// slugs are suffixed `-2`, `-3`, ... in document order so a section
// address never collides. Sections are addressed by their anchor
// (the server's slug), not by a client-chosen key.
export function buildOutline(html: string | null): {
  augmented: string;
  outline: OutlineItem[];
} {
  if (!html) return { augmented: "", outline: [] };
  const outline: OutlineItem[] = [];
  const seen = new Map<string, number>();
  let m: RegExpExecArray | null;
  const re = new RegExp(HEADING_RE.source, "gi");
  while ((m = re.exec(html)) !== null) {
    const level = Number(m[1]);
    const text = decodeEntities(m[2]).trim();
    const base = slugAnchor(text);
    let anchor = base;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) anchor = `${base}-${n}`;
    outline.push({ level, text, anchor });
  }
  let i = 0;
  const augmented = html.replace(HEADING_RE, (_match, lvl, inner) => {
    const row = outline[i];
    i += 1;
    if (!row) return _match;
    return `<h${lvl} id="${row.anchor}">${inner}</h${lvl}>`;
  });
  return { augmented, outline };
}

// Fetch a document's outline server-side. Returns {ok:false} when
// the document does not exist, is not Live, or carries no content.
// Caller is expected to have already resolved may-read upstream;
// this helper does not re-check access (the page runs the check,
// and the write route calls lookupSection which gates separately).
export async function loadOutline(
  docId: string,
  supaIn?: SupabaseClient,
): Promise<
  | { ok: false; reason: "not_found" | "not_live" | "empty" }
  | { ok: true; outline: OutlineItem[]; title: string; version: string | null }
> {
  const supa = supaIn || serviceClient();
  const docQ = await supa
    .from("documents")
    .select("id, title, status, version")
    .eq("id", docId)
    .maybeSingle();
  if (docQ.error || !docQ.data) return { ok: false, reason: "not_found" };
  const d = docQ.data as {
    id: string;
    title: string | null;
    status: string;
    version: string | number | null;
  };
  if (d.status !== "Live") return { ok: false, reason: "not_live" };
  const cQ = await supa
    .from("document_content")
    .select("html")
    .eq("doc_id", docId)
    .eq("lang", "en")
    .maybeSingle();
  if (cQ.error) return { ok: false, reason: "empty" };
  const html = (cQ.data as { html: string | null } | null)?.html ?? "";
  const stripped = stripLeadingTitleH1(html, d.title || docId);
  const { outline } = buildOutline(stripped);
  return {
    ok: true,
    outline,
    title: d.title || docId,
    version: d.version != null ? String(d.version) : null,
  };
}

// Section-key lookup. Returns the matching section's title when the
// anchor is real, or null when the anchor is unknown for this
// document. Null-key means "whole document" and is treated as a
// legitimate choice by callers (the write route accepts it).
export async function lookupSection(
  docId: string,
  anchor: string | null,
  supaIn?: SupabaseClient,
): Promise<
  | { ok: true; title: string | null; version: string | null }
  | { ok: false; reason: "doc_missing" | "section_missing" }
> {
  if (!anchor || anchor.length === 0) {
    const h = await loadOutline(docId, supaIn);
    if (!h.ok) return { ok: false, reason: "doc_missing" };
    return { ok: true, title: null, version: h.version };
  }
  const h = await loadOutline(docId, supaIn);
  if (!h.ok) return { ok: false, reason: "doc_missing" };
  const row = h.outline.find((o) => o.anchor === anchor);
  if (!row) return { ok: false, reason: "section_missing" };
  return { ok: true, title: row.text, version: h.version };
}

// -----------------------------------------------------------------
// Cross-document link resolver. A document's body may name another
// live document by number ("POL-001"). L1 decides whether that
// number is a link (viewer may read the named document) or plain
// text (viewer may not read it). The rule is the same as the page:
// null-level or unknown access_level counts as restricted.
// -----------------------------------------------------------------
export type CrossDocLink = { id: string; href: string | null; title: string | null };

const DOC_ID_RE = /\b[A-Z]{2,6}-\d{3}(?:-[A-Z]{2,4})?\b/g;

export async function resolveCrossDocLink(
  docId: string,
  readerEmail: string,
  supaIn?: SupabaseClient,
): Promise<CrossDocLink> {
  const supa = supaIn || serviceClient();
  const q = await supa
    .from("documents")
    .select("id, status, access_level, title")
    .eq("id", docId)
    .maybeSingle();
  if (q.error || !q.data) return { id: docId, href: null, title: null };
  const row = q.data as {
    id: string;
    status: string;
    access_level: string | null;
    title: string | null;
  };
  if (row.status !== "Live") return { id: row.id, href: null, title: null };
  let identity: Awaited<ReturnType<typeof resolveAcademyIdentity>> = null;
  try {
    identity = await resolveAcademyIdentity(readerEmail, { supa });
  } catch {
    identity = null;
  }
  const level = resolveReaderLevel(readerEmail, identity);
  if (!canReadDocument(level, row.access_level)) {
    return { id: row.id, href: null, title: null };
  }
  return { id: row.id, href: `/library/${row.id}`, title: row.title };
}

// Inject a quiet "Suggest an edit" control at the end of every H1
// section. Server-rendered static HTML - a document-level click
// delegator inside DocControlsIsland catches a click on any
// `[data-kf-sec-anchor]` and dispatches the kf-lb-doctool event
// with the section pre-selected. We use a plain `<button>` inside
// dangerouslySetInnerHTML rather than a React component to avoid
// having to re-render the article body through React (the body
// HTML comes from v1's automation and goes into the DOM as-is).
export function injectSectionEndControls(
  html: string,
  outline: OutlineItem[],
): string {
  if (!html) return html;
  const h1s = outline.filter((o) => o.level === 1);
  if (h1s.length === 0) return html;

  // Find every `<h1 id="...">` opener in order; its section runs to
  // the next H1 opener or the end of the body.
  const openerRe = /<h1[^>]*id="([^"]+)"[^>]*>/gi;
  const openings: Array<{ anchor: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = openerRe.exec(html)) !== null) {
    openings.push({ anchor: m[1], start: m.index, end: m.index + m[0].length });
  }
  if (openings.length === 0) return html;

  // Walk the openings and splice the end-control just before the
  // next opener's `<h1>` tag (or at the end of the body for the
  // last section).
  let out = "";
  let cursor = 0;
  for (let i = 0; i < openings.length; i += 1) {
    const here = openings[i];
    const nextStart = i + 1 < openings.length ? openings[i + 1].start : html.length;
    const anchor = here.anchor;
    const match = h1s.find((o) => o.anchor === anchor);
    if (!match) continue;
    out += html.slice(cursor, nextStart);
    out += sectionEndControlHtml(anchor, match.text);
    cursor = nextStart;
  }
  out += html.slice(cursor);
  return out;
}

function sectionEndControlHtml(anchor: string, text: string): string {
  // Only data-attributes carry anything the reader typed; both are
  // already server-escaped (they are the section's own heading text
  // and slug). Plain text, no interpolation of user input.
  const safeAnchor = escapeAttribute(anchor);
  const safeText = escapeAttribute(text);
  return (
    `<div class="kf-lb-sec-end">` +
    `<button type="button" class="kf-btn kf-btn--ghost kf-lb-sec-end__btn" ` +
    `data-kf-sec-anchor="${safeAnchor}" data-kf-sec-text="${safeText}">` +
    `Suggest an edit about this part` +
    `</button>` +
    `</div>`
  );
}

function escapeAttribute(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wrap bare document numbers in a document's HTML with anchors when
// L1 allows the reader to open them. Numbers we cannot resolve (or
// are restricted) stay as plain text. The page passes the already-
// headings-augmented HTML; we walk only the body text so a number
// that appears INSIDE a heading is also linked. We rewrite the
// smallest-possible span: every token match becomes `<a ...>TOKEN</a>`.
// Called server-side; the final HTML is still injected via
// `dangerouslySetInnerHTML` from the page.
export async function wireCrossDocLinks(
  html: string,
  currentDocId: string,
  readerEmail: string,
  supaIn?: SupabaseClient,
): Promise<string> {
  if (!html) return html;
  const supa = supaIn || serviceClient();
  const found = new Set<string>();
  for (const m of html.matchAll(DOC_ID_RE)) {
    if (m[0] === currentDocId) continue;
    found.add(m[0]);
  }
  if (found.size === 0) return html;
  // One lookup per distinct number.
  const links = new Map<string, CrossDocLink>();
  await Promise.all(
    Array.from(found).map(async (id) => {
      links.set(id, await resolveCrossDocLink(id, readerEmail, supa));
    }),
  );
  // Replace every token. Protect against replacing inside attributes
  // by only replacing when the token is NOT preceded by `="` or `=`.
  // The Library's stored HTML uses `href="/library/<id>"` for the few
  // already-wired links; we skip those to avoid wrapping an anchor.
  return html.replace(DOC_ID_RE, (match, offset: number) => {
    if (match === currentDocId) return match;
    const look = links.get(match);
    if (!look) return match;
    // Guard against replacing inside an existing anchor: look back
    // for a close-angle after a preceding `<a`.
    const before = html.slice(Math.max(0, offset - 160), offset);
    if (/<a\b[^>]*$/i.test(before)) return match;
    if (/<a\b[^<]*>[^<]*$/i.test(before)) return match;
    if (look.href) {
      // Carry ?from=<current-doc-url> so BackLink on the next page
      // lands them back here under the "Back to the last document"
      // variant. BackLink's isSafeInternal check only accepts a
      // /library/<id> value so the param cannot be re-pointed.
      const from = `/library/${currentDocId}`;
      return `<a class="kf-doclink" href="${look.href}?from=${encodeURIComponent(from)}">${match}</a>`;
    }
    // Plain text - but mark it so the span is still styled as a
    // document number (mono), just without a link.
    return `<span class="kf-doclink kf-doclink--plain">${match}</span>`;
  });
}
