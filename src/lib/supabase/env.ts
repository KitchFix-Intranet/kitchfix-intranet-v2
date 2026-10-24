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
