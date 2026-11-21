import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatWhen } from "../codingPageData.ts";

// Fix 2.5: show the "Sent" time in Central time, 12-hour, with the
// zone word CT. Intl with timeZone "America/Chicago" handles DST,
// so the same local wall time shows the same text in winter (CST)
// and summer (CDT), even when the moment crosses UTC midnight.

test("winter evening that crosses UTC midnight (CST, UTC-6): 8:34 PM Nov 20 = 02:34 UTC Nov 21", () => {
  // 2026-11-20 20:34 America/Chicago (CST) = 2026-11-21 02:34:00 UTC
  const iso = "2026-11-21T02:34:00Z";
  assert.equal(formatWhen(iso), "11/20/2026 8:34 PM CT");
});

test("summer evening that crosses UTC midnight (CDT, UTC-5): 8:34 PM Jul 15 = 01:34 UTC Jul 16", () => {
  // 2026-07-15 20:34 America/Chicago (CDT) = 2026-07-16 01:34:00 UTC
  const iso = "2026-07-16T01:34:00Z";
  assert.equal(formatWhen(iso), "07/15/2026 8:34 PM CT");
});

test("morning in CST does not cross midnight: 8:34 AM Nov 20 CST = 14:34 UTC Nov 20", () => {
  const iso = "2026-11-20T14:34:00Z";
  assert.equal(formatWhen(iso), "11/20/2026 8:34 AM CT");
});

test("noon reads 12:00 PM CT", () => {
  // 2026-11-20 12:00 CST = 18:00 UTC
  const iso = "2026-11-20T18:00:00Z";
  assert.equal(formatWhen(iso), "11/20/2026 12:00 PM CT");
});

test("midnight CT reads 12:00 AM CT", () => {
  // 2026-11-20 00:00 CST = 06:00 UTC
  const iso = "2026-11-20T06:00:00Z";
  assert.equal(formatWhen(iso), "11/20/2026 12:00 AM CT");
});

test("invalid timestamp returns the input unchanged", () => {
  assert.equal(formatWhen("not a date"), "not a date");
});
