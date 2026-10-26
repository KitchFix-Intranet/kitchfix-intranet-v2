// Document-class humanizer. documents.doc_class stores raw codes
// (PB, SOP, POL, REF, TPL, REC, FORM, POST, STD, AGR, CHK) that are
// never shown to a chef. The Library surfaces label them with this
// map; unknown codes fall back to title-case so the surface never
// shows a bare three-letter code even if a new class is added
// before this map catches up.
//
// Shared by /library (shelf browse), /library/[docId] (document
// header + facts rail), and anywhere else a doc_class is rendered.

const CLASS_LABELS: Readonly<Record<string, string>> = {
  PB: "Playbook",
  SOP: "SOP",
  POL: "Policy",
  REF: "Reference",
  TPL: "Template",
  REC: "Record",
  FORM: "Form",
  POST: "Poster",
  STD: "Standard",
  AGR: "Agreement",
  CHK: "Checklist",
};

export function humanizeDocClass(code: string | null | undefined): string {
  const raw = String(code || "").trim();
  if (!raw) return "";
  const hit = CLASS_LABELS[raw];
  if (hit) return hit;
  // Unknown code: title-case so "ABC" -> "Abc" and "foo-bar" -> "Foo-Bar".
  // Never return the raw code to the UI.
  return raw
    .toLowerCase()
    .split(/[\s-_]+/)
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ")
    .trim();
}
