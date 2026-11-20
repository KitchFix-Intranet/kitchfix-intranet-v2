// Tiny shared module for the custom event the top-bar toolbar
// dispatches and the on-page island listens for. A plain module -
// NO "use client" - so a server page can import the constants
// without crossing the RSC boundary (gotcha #13.4).

export const DOC_TOOL_EVENT = "kf-lb-doctool";

export type DocToolEventDetail = {
  kind: "details" | "share" | "suggest";
  docId: string;
  docTitle: string;
  // Suggest can be opened pre-targeted at a section (the "Suggest
  // an edit" link at the end of each section). Null means "the
  // whole document".
  section?: { anchor: string; text: string } | null;
};
