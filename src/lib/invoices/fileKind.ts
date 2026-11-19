// File-kind magic-byte check for Capture. Pure.
//
// Train 2 (§6) accepts PDF, JPEG, PNG, WebP. HEIC is refused here
// with plain words ("Save it as a PDF or a JPEG and add it again").
// The DB bucket allow-list is wider (see the SQL migration record)
// so a different train can let HEIC in without a schema change; the
// app is the gate today.
//
// The browser's claimed MIME is never trusted. We read the first
// bytes and match a magic sequence. A shorter buffer (<16 bytes) is
// a reject.

export interface DetectedKind { mime: AcceptedMime; ext: AcceptedExt }
export type AcceptedMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
export type AcceptedExt = "pdf" | "jpg" | "png" | "webp";

// Also keep an "unaccepted but recognisable" row so we can give a
// specific message for HEIC ("save it as a PDF or a JPEG").
export type DetectedUnaccepted = "heic";

export interface DetectResult {
  // null -> not any kind we recognise
  // unaccepted -> HEIC
  // accepted -> one of the four
  kind: DetectedKind | null;
  unaccepted: DetectedUnaccepted | null;
}

const ACCEPTED: Array<DetectedKind & { match: (b: Uint8Array) => boolean }> = [
  { mime: "application/pdf", ext: "pdf",
    match: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { mime: "image/jpeg", ext: "jpg",
    match: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: "image/png", ext: "png",
    match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
                && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A },
  { mime: "image/webp", ext: "webp",
    match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

// HEIC file type box (ISO BMFF): `ftyp` at offset 4, then one of
// heic/heix/mif1.
function matchesHeic(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  if (!(b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)) return false;
  const brand4 = String.fromCharCode(b[8], b[9], b[10], b[11]);
  return brand4 === "heic" || brand4 === "heix" || brand4 === "mif1";
}

export function detectKind(bytes: Uint8Array): DetectResult {
  if (bytes.length < 16) return { kind: null, unaccepted: null };
  for (const row of ACCEPTED) {
    if (row.match(bytes)) return { kind: { mime: row.mime, ext: row.ext }, unaccepted: null };
  }
  if (matchesHeic(bytes)) return { kind: null, unaccepted: "heic" };
  return { kind: null, unaccepted: null };
}
