import type { Metadata } from "next";
import { headers } from "next/headers";
import { requireAppAccess } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { currentPeriod } from "@/lib/fiscalPeriod";
import { fmtDate, nameFromEmail } from "@/lib/fmt";
import { Shell } from "@/components/shell/Shell";
import { RevealGate } from "@/components/ui/RevealGate";
import { tabTitleFor } from "@/components/shell/routeTitles";
import { resolveAcademyIdentity } from "@/lib/academy/identity";

// Full-load browser-tab title. Shares tabTitleFor() with the client-side
// TabTitle island so both prongs produce the same string. Reads x-pathname
// (set by the middleware); the x-invoke-path fallback preserves the same
// defence this file's shell-patch-3 fix already relies on.
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const pathname = h.get("x-pathname") ?? h.get("x-invoke-path") ?? "/";
  return { title: tabTitleFor(pathname) };
}

// Shell patch 3 (2026-11-12): the topbar title + crumb map moved to
// src/components/shell/routeTitles.tsx. Shell.tsx now owns the
// derivation via usePathname() so client navigations update the h1.
// This file keeps reading x-pathname for requireAppAccess and the
// Academy count; it no longer computes a title.

export default async function ShellLayout({
  children,
  topbar,
}: {
  children: React.ReactNode;
  topbar: React.ReactNode;
}) {
  // Read the pathname first so the gate can apply its path allowlist.
  // Order matters: the shell layout cannot gate on the owner alone
  // once the release switch is on - it must know which route the
  // viewer is trying to reach to apply isOpenedPath.
  const h = await headers();
  // Read our middleware-set x-pathname first. x-invoke-path is a
  // Next internal that is not populated for App Router RSCs in Next
  // 16 production; the "/"-fallback leaks "Home" into every shell
  // route and feeds "/" to the access gate's path allowlist.
  const pathname = h.get("x-pathname") ?? h.get("x-invoke-path") ?? "/";
  const { email, role } = await requireAppAccess(pathname);

  // Pull the user's display name once at the layout boundary so Shell can
  // render it in the account button. The shell never sees the address -
  // when pr_users.name is missing we derive a name from the local part on
  // the server (same helper Home uses for its greeting) and pass only the
  // result down. Section 6: nothing that carries a person's address
  // reaches the browser unless the screen needs it; this screen does not.
  const client = serviceClient();
  const { data: userRow } = await client
    .from("pr_users")
    .select("name")
    .eq("email", email)
    .maybeSingle();
  const dbName = (userRow as { name: string | null } | null)?.name ?? "";
  const derived = nameFromEmail(email);
  // Account row fallback: "Account" when the derivation yields "there".
  const name = dbName && dbName.length > 0 ? dbName : derived === "there" ? "Account" : derived;

  const period = await currentPeriod();
  const dateLong = fmtDate(new Date().toISOString(), "long");
  const periodTag = period ? `Period ${period.period_no}, week ${period.week}` : null;

  // Academy rail count. Only fetch when on an Academy route (one extra
  // round-trip per request on that section only). Null elsewhere so the
  // Shell knows not to render the badge. Resolver failures or missing
  // roster rows yield null, not a visible 0 - a count of 0 means "all
  // caught up" and the badge should hide, which is what null does.
  let todoCount: number | null = null;
  if (pathname === "/academy" || pathname.startsWith("/academy/")) {
    try {
      const identity = await resolveAcademyIdentity(email, { supa: client });
      if (identity) {
        const { count } = await client
          .from("academy_requirements")
          .select("requirement_id", { count: "exact", head: true })
          .eq("worker_id", identity.workerId)
          .is("waived_at", null);
        if (typeof count === "number") {
          // Signatures live in academy_attestations; subtract them from
          // the raw requirements count to get "remaining".
          const { count: signedCount } = await client
            .from("academy_attestations")
            .select("attestation_id", { count: "exact", head: true })
            .eq("worker_id", identity.workerId);
          const remaining = Math.max(0, count - (signedCount ?? 0));
          todoCount = remaining;
        }
      }
    } catch {
      // non-fatal, badge hides
    }
  }

  // `requireAppAccess` returned the viewer's role. The release flag
  // is CLOSED by default - with it off, a non-owner would have
  // already 404'd; only owners reach here. With the flag on, a lead
  // or learner on an opened path also reaches here. The Shell nav
  // uses isOwner to gate the Admin rail entry (and in future, every
  // owner-only door); non-owners never see them.
  const isOwner = role === "owner";

  return (
    <Shell
      name={name}
      dateLong={dateLong}
      periodTag={periodTag}
      topbar={topbar}
      todoCount={todoCount}
      isOwner={isOwner}
      role={role}
    >
      <RevealGate />
      {children}
    </Shell>
  );
}
