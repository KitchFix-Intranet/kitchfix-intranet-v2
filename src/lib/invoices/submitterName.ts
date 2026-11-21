// Pure. Pull a first name + a single-letter last initial out of
// `people.display_name`. Used by the coding page's byline.
//
// Correction 6: nothing is ever derived from an email address.
// This function takes the display_name string only. A missing or
// blank value returns nulls; the byline is then left off.

export interface SubmitterName {
  first_name: string | null;
  last_initial: string | null;
}

export function parseSubmitterName(displayName: string | null | undefined): SubmitterName {
  if (!displayName) return { first_name: null, last_initial: null };
  const parts = String(displayName).trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) return { first_name: null, last_initial: null };
  const first = parts[0];
  if (parts.length === 1) return { first_name: first, last_initial: null };
  const last = parts[parts.length - 1];
  const initial = last.charAt(0);
  return { first_name: first, last_initial: /[A-Za-z]/.test(initial) ? initial.toUpperCase() : null };
}
