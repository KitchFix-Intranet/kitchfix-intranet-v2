"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { tabTitleFor } from "./routeTitles";

// The client half of the browser-tab title. Full loads land correct via
// (shell)/layout.tsx's generateMetadata; a shared (shell) layout does
// not re-render on sibling navigation (Next App Router: layouts preserve
// state and do not read pathname), so client navigations need a client
// writer. usePathname() re-renders this island on every nav - including
// browser Back and Forward - and the effect writes document.title from
// the same tabTitleFor() the server uses, so both paths agree.
export function TabTitle() {
  const pathname = usePathname();
  useEffect(() => {
    document.title = tabTitleFor(pathname);
  }, [pathname]);
  return null;
}
