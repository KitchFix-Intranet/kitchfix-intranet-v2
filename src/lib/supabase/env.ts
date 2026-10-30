export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `Missing required env var ${name}. The complete env set lives in .env.example (5 names only).`
    );
  }
  return v;
}

export function ownerEmails(): Set<string> {
  const raw = process.env.OWNER_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

// Release switch. Default CLOSED. Returns `true` ONLY when the env
// var equals the literal string "true" (trimmed, lowercased); every
// other value (unset, empty, "1", "yes", "TRUE  " with trailing
// spaces, a typo, a leaked newline) returns `false`. A missing or
// malformed env var MUST NOT open access.
//
// Reads from process.env on every call so a Vercel env change takes
// effect on the next request without a bundle rebuild. Not cached.
export function appOpenToNonOwners(): boolean {
  const raw = process.env.V2_OPEN_TO_NONOWNERS;
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === "true";
}
