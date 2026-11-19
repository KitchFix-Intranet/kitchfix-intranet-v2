// SHA-256 of a byte buffer for Capture. Server-only.
//
// The DB's `invoice_files.sha256` CHECK is `~ '^[0-9a-f]{64}$'`, so
// lowercase hex is required.

import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
