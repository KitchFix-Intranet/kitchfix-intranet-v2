// Pure. Fix 6: pdf-lib's built-in fonts (StandardFonts.Helvetica
// + Helvetica-Bold) encode WinAnsi only. Anything outside printable
// ASCII and Latin-1 supplement (and a handful of WinAnsi quirks)
// makes drawText throw at render time. Emoji, CJK, most non-Latin
// scripts all do.
//
// This helper replaces every unencodable character with "?" so a
// pathological vendor name or display name can never crash the PDF
// build. Called on every string handed to drawText.
//
// The allowed set is conservative: printable ASCII (0x20..0x7E),
// non-break-space, and printable Latin-1 (0xA1..0xFF). Characters
// a WinAnsi encoder could technically round-trip beyond that
// (curly quotes, en-dash, em-dash, etc. live in 0x91..0x9F) are
// also treated as "?" because their encoder lookup differs across
// pdf-lib versions. Simpler to drop them.

export function encodeForFont(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // Surrogates: emoji / astral chars. One char on screen is two
    // JS code units; replace both with a single "?".
    if (code >= 0xD800 && code <= 0xDBFF) {
      out += "?";
      if (i + 1 < s.length) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) i += 1;
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      out += "?";
      continue;
    }
    // Printable ASCII.
    if (code >= 0x20 && code <= 0x7E) { out += s[i]; continue; }
    // Tab -> space (preserve layout better than "?").
    if (code === 0x09) { out += " "; continue; }
    // Non-break space.
    if (code === 0xA0) { out += s[i]; continue; }
    // Printable Latin-1 supplement.
    if (code >= 0xA1 && code <= 0xFF) { out += s[i]; continue; }
    // Anything else: replace.
    out += "?";
  }
  return out;
}
