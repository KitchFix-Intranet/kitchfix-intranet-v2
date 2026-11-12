// Shell lane owns the function, types, fallback, Home entry, and the order rules.
// Each section lane may ADD AND EDIT ONLY its own rows: People → /people...; Academy + Library → /academy..., /library...; Stockpot → /stockpot...

import type { ReactNode } from "react";

// Topbar title + crumb map. One entry per route; a non-match falls back to
// "KitchFix" with no crumb (the fallback used to render the raw pathname,
// which leaked route strings into product chrome).
type Hit = { title: string; crumb?: string };

export function titleFor(pathname: string, dateLong: string, periodTag: string | null): { title: string; crumb?: ReactNode } {
  const map: Array<{ test: (p: string) => boolean; v: Hit }> = [
    { test: (p) => p === "/people",   v: { title: "My team",           crumb: "People Portal" } },
    // People Portal T0a. Specificity order: incidents/new (and under) wins
    // over /people/incidents/:id, which wins over the /incidents index.
    // Array.find stops at the first match, so the test order is the rule.
    { test: (p) => p === "/people/incidents/new" || p.startsWith("/people/incidents/new/"), v: { title: "Incident Report", crumb: "People Portal" } },
    { test: (p) => p === "/people/incidents",                                 v: { title: "Incidents",       crumb: "People Portal" } },
    { test: (p) => p.startsWith("/people/incidents/"),                        v: { title: "Incident",        crumb: "People Portal" } },
    { test: (p) => p === "/people/inbox",                                     v: { title: "Inbox",           crumb: "People Portal" } },
    { test: (p) => p === "/people/new-hire",                                  v: { title: "New Hire",        crumb: "People Portal" } },
    { test: (p) => p === "/people/paf" || p.startsWith("/people/paf/"),       v: { title: "PAF",             crumb: "People Portal" } },
    { test: (p) => p === "/people/review",                                    v: { title: "Review",          crumb: "People Portal" } },
    { test: (p) => p === "/ops",      v: { title: "Ops Hub",           crumb: "On the current intranet" } },
    { test: (p) => p === "/service",  v: { title: "Service Calendar",  crumb: "On the current intranet" } },
    { test: (p) => p === "/kpi",      v: { title: "KPI Dashboard",     crumb: "On the current intranet" } },
    { test: (p) => p === "/academy",         v: { title: "To do",      crumb: "Academy" } },
    { test: (p) => p === "/academy/done",    v: { title: "Done",       crumb: "Academy" } },
    { test: (p) => p.startsWith("/academy/read/"), v: { title: "Reading", crumb: "Academy / To do" } },
    { test: (p) => p === "/academy/admin",          v: { title: "Admin",      crumb: "Cycles" } },
    { test: (p) => p === "/academy/admin/people",   v: { title: "Admin",      crumb: "People" } },
    { test: (p) => p === "/academy/team",            v: { title: "Team",       crumb: "Your team's compliance" } },
    { test: (p) => p === "/library",                v: { title: "Library",  crumb: "Find any document" } },
    { test: (p) => p === "/library/shelves",        v: { title: "Library",  crumb: "Every operating document, current" } },
    { test: (p) => p.startsWith("/library/"),       v: { title: "Document", crumb: "Library" } },
    { test: (p) => p === "/stockpot" || p === "/stockpot/ingredients", v: { title: "Ingredients", crumb: "Stockpot / Culinary office" } },
    { test: (p) => p === "/stockpot/ingredients/ingredients", v: { title: "Ingredients",  crumb: "Stockpot / Ingredients" } },
    { test: (p) => p === "/stockpot/ingredients/review",      v: { title: "Review queue", crumb: "Stockpot / Ingredients" } },
    { test: (p) => p === "/stockpot/ingredients/retail",      v: { title: "Retail",       crumb: "Stockpot / Ingredients" } },
    { test: (p) => p === "/stockpot/ingredients/vendor-items", v: { title: "Vendor items", crumb: "Stockpot / Ingredients" } },
    { test: (p) => p === "/stockpot/ingredients/admin",       v: { title: "Admin",        crumb: "Stockpot / Ingredients" } },
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
