// Money input parsing for Capture. Pure.
//
// Accepts digits and up to one decimal point. Commas allowed and
// stripped. Leading / trailing whitespace trimmed. Rejects anything
// else (letters, signs, scientific notation). Totals are stored as
// typed, positive, for invoices and credits alike (§6 - train 3
// owns the sign).
//
// Returns the parsed number rounded to cents, or `null` when the
// input is not a valid money value. Returns `0` for the literal "0"
// or "0.00" (callers decide if 0 is a valid total).

export function parseMoneyInput(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Accept an optional leading "$". Nothing else.
  if (s.startsWith("$")) s = s.slice(1).trim();
  // Strip thousands-separator commas; one or more commas are fine.
  s = s.replace(/,/g, "");
  // The only valid shape now: optional digits, optional one dot,
  // optional digits. At least one digit on one side of the dot.
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  // Round to cents to avoid 1e-9 drift.
  return Math.round(n * 100) / 100;
}

// "Does this string look like money so far?" - used by the client
// input to decide whether to keep a keystroke. Allows a trailing
// dot (mid-typing) and a lone decimal point.
export function looksLikeMoneyDuringTyping(raw: string): boolean {
  if (raw === "") return true;
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (s === ".") return true;
  return /^\d*(\.\d*)?$/.test(s);
}
