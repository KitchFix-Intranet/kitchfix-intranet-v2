// Shared text normalization. Used by vendor seeding, intake item-key
// derivation, and alias dedupe. Combining-mark range strips the diacritics
// left over by NFKD normalize.

const COMBINING_MARKS = /[̀-ͯ]/g;

export function nameNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

export function itemNumberNorm(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  if (t.length === 0) return null;
  const stripped = t.replace(/^0+/, "");
  const base = stripped.length === 0 ? "0" : stripped;
  return base.toUpperCase();
}

// descriptionKey: used when item_number is missing. Preserves /#.&%- so SKU-ish
// fragments inside the description still key cleanly ("SALT TBL #25" and
// "SALT TBL #25 BOX" diverge; "SALT, TABLE" and "Salt   TABLE" collapse).
export function descriptionKey(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/[^A-Z0-9/#.&%\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function descriptionNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/\s+/g, " ")
    .trim();
}
