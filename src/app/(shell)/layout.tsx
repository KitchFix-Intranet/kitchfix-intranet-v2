import { headers } from "next/headers";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { currentPeriod } from "@/lib/fiscalPeriod";
import { fmtDate } from "@/lib/fmt";
import { Shell } from "@/components/shell/Shell";
import { RevealGate } from "@/components/ui/RevealGate";
import { resolveAcademyIdentity } from "@/lib/academy/identity";

// Topbar title + crumb map. One entry per route; a non-match falls back to
// "KitchFix" with no crumb (the fallback used to render the raw pathname,
// which leaked route strings into product chrome).
type Hit = { title: string; crumb?: string };
function titleFor(pathname: string, dateLong: string, periodTag: string | null): { title: string; crumb?: React.ReactNode } {
  const map: Array<{ test: (p: string) => boolean; v: Hit }> = [
    { test: (p) => p === "/people",   v: { title: "People Portal",     crumb: "On the current intranet" } },
    { test: (p) => p === "/ops",      v: { title: "Ops Hub",           crumb: "On the current intranet" } },
    { test: (p) => p === "/service",  v: { title: "Service Calendar",  crumb: "On the current intranet" } },
    { test: (p) => p === "/kpi",      v: { title: "KPI Dashboard",     crumb: "On the current intranet" } },
    { test: (p) => p === "/academy",         v: { title: "To do",      crumb: "Academy" } },
    { test: (p) => p === "/academy/done",    v: { title: "Done",       crumb: "Academy" } },
    { test: (p) => p.startsWith("/academy/read/"), v: { title: "Reading", crumb: "Academy / To do" } },
    { test: (p) => p === "/academy/admin",          v: { title: "Admin",      crumb: "Cycles" } },
    { test: (p) => p === "/academy/admin/people",   v: { title: "Admin",      crumb: "People" } },
    { test: (p) => p === "/library",                v: { title: "Library",  crumb: "Find any document" } },
    { test: (p) => p === "/library/shelves",        v: { title: "Library",  crumb: "Every operating document, current" } },
    { test: (p) => p.startsWith("/library/"),       v: { title: "Document", crumb: "Library" } },
    { test: (p) => p === "/stockpot" || p === "/stockpot/ingredients", v: { title: "Ingredients", crumb: "Stockpot / Culinary office" } },
    { test: (p) => p === "/stockpot/ingredients/vendor-items", v: { title: "Vendor items", crumb: "Stockpot / Ingredients" } },
    { test: (p) => p === "/stockpot/recipes", v: { title: "Recipes", crumb: "Stockpot" } },
    { test: (p) => p === "/stockpot/menus",   v: { title: "Menus",   crumb: "Stockpot" } },
    { test: (p) => p === "/stockpot/signs",   v: { title: "Signs & labels", crumb: "Stockpot" } },
  ];
  if (pathname === "/") {
    return {
      title: "Home",
      crumb: (
        <>
          <span>{dateLong}</span>
          {periodTag ? (
            <span className="kf-skew-tag"><span>{periodTag}</span></span>
          ) : null}
        </>
      ),
    };
  }
  const hit = map.find((m) => m.test(pathname));
  return { title: hit?.v.title ?? "KitchFix", crumb: hit?.v.crumb };
}

export default async function ShellLayout({
  children,
  topbar,
}: {
  children: React.ReactNode;
  topbar: React.ReactNode;
}) {
  const { email } = await requireOwnerPage();
  const h = await headers();
  const pathname = h.get("x-invoke-path") ?? h.get("x-pathname") ?? "/";

  // Pull the user's display name once at the layout boundary so Shell can
  // render it in the account button and Home can read it in its band.
  const client = serviceClient();
  const { data: userRow } = await client
    .from("pr_users")
    .select("name")
    .eq("email", email)
    .maybeSingle();
  const name = (userRow as { name: string | null } | null)?.name ?? "";

  const period = await currentPeriod();
  const dateLong = fmtDate(new Date().toISOString(), "long");
  const periodTag = period ? `Period ${period.period_no}, week ${period.week}` : null;
  const { title, crumb } = titleFor(pathname, dateLong, periodTag);

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

  // `requireOwnerPage` 404s a non-owner before this returns, so if we
  // got here the viewer IS an owner. Pass it through so the Admin
  // rail entry is correctly gated when the layout gate changes to
  // let learners in (train F+). Keeping the signal explicit means
  // Shell does not need to know about `requireOwnerPage`.
  const isOwner = true;

  return (
    <Shell
      email={email}
      name={name}
      title={title}
      crumb={crumb}
      topbar={topbar}
      todoCount={todoCount}
      isOwner={isOwner}
    >
      <RevealGate />
      {children}
    </Shell>
  );
}
