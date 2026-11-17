// Shared URL builder for the list surface. Pure. Imported by both
// client (Toolbar, Drawer, cards) and server (ShowOlder, surface)
// components so we don't carry two copies of the same logic.

import type { FilterKey } from "@/lib/invoices/types";

export function buildListHref(args: {
  show: FilterKey;
  q: string | null;
  site: string | null;
  inv: string | null;
  more: number;
  asParam: string | null;
}): string {
  const p = new URLSearchParams();
  if (args.site) p.set("site", args.site);
  if (args.show && args.show !== "all") p.set("show", args.show);
  if (args.q) p.set("q", args.q);
  if (args.inv) p.set("inv", args.inv);
  if (args.more > 1) p.set("more", String(args.more));
  if (args.asParam) p.set("as", args.asParam);
  const qs = p.toString();
  return qs ? `/invoices/list?${qs}` : `/invoices/list`;
}

// A close href for the drawer: everything the toolbar carries,
// minus `inv`. Keeps filter/search/site/more/as intact so the
// scroll position survives and the list state is unchanged on
// return.
export function buildDrawerCloseHref(args: {
  show: FilterKey;
  q: string | null;
  site: string | null;
  more: number;
  asParam: string | null;
}): string {
  return buildListHref({ ...args, inv: null });
}

// "Open the drawer for this row" href: everything plus inv=<id>.
export function buildDrawerOpenHref(args: {
  show: FilterKey;
  q: string | null;
  site: string | null;
  more: number;
  asParam: string | null;
  invId: string;
}): string {
  return buildListHref({
    show: args.show,
    q: args.q,
    site: args.site,
    inv: args.invId,
    more: args.more,
    asParam: args.asParam,
  });
}
