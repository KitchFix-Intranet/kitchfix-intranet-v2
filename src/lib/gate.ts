// Gate helpers. The OWNER_EMAILS allowlist is checked here. A non-owner (or
// unauthenticated request) in a protected page triggers notFound() so Next
// renders the plain app/not-found page. In protected APIs the helper returns
// a Response the handler returns verbatim.

import { notFound } from "next/navigation";
import { sessionEmail } from "./supabase/ssr";
import { ownerEmails } from "./supabase/env";

export async function requireOwnerPage(): Promise<{ email: string }> {
  const email = await sessionEmail();
  if (!email) notFound();
  const owners = ownerEmails();
  if (!owners.has(email)) notFound();
  return { email };
}

export async function requireOwnerApi(): Promise<Response | { email: string }> {
  const email = await sessionEmail();
  if (!email) return new Response(null, { status: 401 });
  const owners = ownerEmails();
  if (!owners.has(email)) return new Response(null, { status: 404 });
  return { email };
}

export function isCronAuthorized(req: Request): boolean {
  const header = req.headers.get("x-cron-secret") ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  return expected.length > 0 && header === expected;
}
