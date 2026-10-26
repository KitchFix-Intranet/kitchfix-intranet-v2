import { headers } from "next/headers";
import { requireOwnerPage } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { currentPeriod } from "@/lib/fiscalPeriod";
import { fmtDate } from "@/lib/fmt";
import { Shell } from "@/components/shell/Shell";
import { RevealGate } from "@/components/ui/RevealGate";

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
    { test: (p) => p === "/academy",  v: { title: "Academy",           crumb: "On the current intranet" } },
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

  return (
    <Shell email={email} name={name} title={title} crumb={crumb} topbar={topbar}>
      <RevealGate />
      {children}
    </Shell>
  );
}
