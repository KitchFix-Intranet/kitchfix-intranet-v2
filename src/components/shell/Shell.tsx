"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Home as HomeIcon,
  Users,
  Settings,
  Calendar,
  BarChart2,
  BookOpen,
  ChefHat,
  Menu as MenuIcon,
  X,
  ChevronLeft,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  Soup,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
} from "lucide-react";
import "./shell.css";

export type NavItem = {
  href: string;
  label: string;
  Icon: typeof HomeIcon;
  liveDot?: boolean;
};

// Shell-level nav: Home + the six tool doors.
const SHELL_NAV: NavItem[] = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/people", label: "People Portal", Icon: Users },
  { href: "/ops", label: "Ops Hub", Icon: Settings },
  { href: "/service", label: "Service Calendar", Icon: Calendar },
  { href: "/kpi", label: "KPI Dashboard", Icon: BarChart2 },
  { href: "/academy", label: "Academy", Icon: BookOpen },
  { href: "/stockpot", label: "Stockpot", Icon: ChefHat, liveDot: true },
];

// Stockpot-level nav: tool pages + climb-out row.
const STOCKPOT_NAV: NavItem[] = [
  { href: "/stockpot/ingredients", label: "Ingredients", Icon: Soup },
  { href: "/stockpot/recipes", label: "Recipes", Icon: FileText },
  { href: "/stockpot/menus", label: "Menus", Icon: LayoutGrid },
  { href: "/stockpot/signs", label: "Signs & labels", Icon: ImageIcon },
];

const PHONE_SHELL_TABS: Array<NavItem | { kind: "menu" }> = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/stockpot", label: "Stockpot", Icon: ChefHat },
  { href: "/people", label: "People", Icon: Users },
  { href: "/ops", label: "Ops", Icon: Settings },
  { kind: "menu" },
];

const PHONE_STOCKPOT_TABS: Array<NavItem | { kind: "menu" }> = [
  { href: "/stockpot/ingredients", label: "Ingredients", Icon: Soup },
  { href: "/stockpot/recipes", label: "Recipes", Icon: FileText },
  { href: "/stockpot/menus", label: "Menus", Icon: LayoutGrid },
  { href: "/stockpot/signs", label: "Signs", Icon: ImageIcon },
  { kind: "menu" },
];

function isStockpotRoute(pathname: string): boolean {
  return pathname === "/stockpot" || pathname.startsWith("/stockpot/");
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Shell({
  children,
  email,
}: {
  children: React.ReactNode;
  email: string;
}) {
  const pathname = usePathname();
  const inStockpot = isStockpotRoute(pathname);
  const nav = inStockpot ? STOCKPOT_NAV : SHELL_NAV;
  const phoneTabs = inStockpot ? PHONE_STOCKPOT_TABS : PHONE_SHELL_TABS;

  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("kf.rail.collapsed");
      if (raw === "1") setCollapsed(true);
    } catch {
      // private mode or similar; non-fatal
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("kf.rail.collapsed", collapsed ? "1" : "0");
    } catch {
      // non-fatal
    }
  }, [collapsed]);

  useEffect(() => setDrawerOpen(false), [pathname]);

  return (
    <div className={`kf-shell${collapsed ? " kf-shell--slim" : ""}`}>
      <aside
        className={`kf-rail${drawerOpen ? " kf-rail--open" : ""}`}
        aria-label="Main navigation"
      >
        <div className="kf-rail__brand">
          <span className="kf-rail__brand-mark" aria-label="KitchFix">
            {collapsed ? (
              <img
                src="/brand/kitchfix-white-circle.png"
                alt="KitchFix"
                className="kf-rail__logo kf-rail__logo--circle"
              />
            ) : (
              <img
                src="/brand/kitchfix-white-stacked.png"
                alt="KitchFix"
                className="kf-rail__logo kf-rail__logo--stacked"
              />
            )}
          </span>
          <button
            type="button"
            className="kf-rail__collapse kf-only-desktop"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand rail" : "Collapse rail"}
            title={collapsed ? "Expand rail" : "Collapse rail"}
          >
            {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.5} /> : <PanelLeftClose size={18} strokeWidth={1.5} />}
          </button>
          <button
            type="button"
            className="kf-rail__close kf-only-phone"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        {inStockpot ? (
          <Link href="/" className="kf-rail__back">
            <ChevronLeft size={16} />
            <span>All tools</span>
          </Link>
        ) : null}

        <nav className="kf-rail__nav">
          <ul>
            {nav.map(({ href, label, Icon, liveDot }) => (
              <li key={href}>
                <Link
                  href={href}
                  className={`kf-rail__item${isActive(pathname, href) ? " kf-rail__item--active" : ""}`}
                  title={label}
                >
                  <Icon size={20} strokeWidth={1.5} />
                  <span className="kf-rail__label">{label}</span>
                  {liveDot ? <span className="kf-rail__dot" aria-label="live" /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="kf-rail__foot">
          <div className="kf-rail__who" title={email}>{email}</div>
          <form action="/api/auth/signout" method="post">
            <button type="submit" className="kf-rail__signout">
              <LogOut size={16} strokeWidth={1.5} />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </aside>

      {drawerOpen ? (
        <div
          className="kf-rail__backdrop kf-only-phone"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      ) : null}

      <div className="kf-main">
        <header className="kf-topbar">
          <button
            type="button"
            className="kf-topbar__burger kf-only-phone"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <MenuIcon size={20} strokeWidth={1.5} />
          </button>
          <div className="kf-topbar__title">
            <TopbarTitle pathname={pathname} />
          </div>
        </header>
        <main className="kf-canvas">{children}</main>
      </div>

      <nav className="kf-tabbar kf-only-phone" aria-label="Section">
        {phoneTabs.map((t, i) =>
          "kind" in t ? (
            <button
              key="menu"
              type="button"
              className="kf-tabbar__item"
              onClick={() => setDrawerOpen(true)}
              aria-label="Menu"
            >
              <MenuIcon size={20} strokeWidth={1.5} />
              <span>Menu</span>
            </button>
          ) : (
            <Link
              key={t.href}
              href={t.href}
              className={`kf-tabbar__item${isActive(pathname, t.href) ? " kf-tabbar__item--active" : ""}`}
            >
              <t.Icon size={20} strokeWidth={1.5} />
              <span>{t.label}</span>
            </Link>
          )
        )}
      </nav>
    </div>
  );
}

function TopbarTitle({ pathname }: { pathname: string }) {
  // Every entry here must land somewhere. The fallback at the bottom used to
  // render the raw pathname when a new route was added without a mapping,
  // which leaked route strings into product chrome (e.g. "/stockpot/recipes"
  // as the Recipes page title). Keep the map exhaustive.
  const map: Array<{ test: (p: string) => boolean; title: string; context?: string }> = [
    { test: (p) => p === "/", title: "KitchFix" },
    { test: (p) => p === "/people", title: "People Portal", context: "Reserved door" },
    { test: (p) => p === "/ops", title: "Ops Hub", context: "Reserved door" },
    { test: (p) => p === "/service", title: "Service Calendar", context: "Reserved door" },
    { test: (p) => p === "/kpi", title: "KPI Dashboard", context: "Reserved door" },
    { test: (p) => p === "/academy", title: "Academy", context: "Reserved door" },
    { test: (p) => p === "/stockpot" || p === "/stockpot/ingredients", title: "Ingredients", context: "Stockpot" },
    { test: (p) => p === "/stockpot/ingredients/vendor-items", title: "Vendor items", context: "Stockpot / Ingredients" },
    { test: (p) => p === "/stockpot/recipes", title: "Recipes", context: "Stockpot" },
    { test: (p) => p === "/stockpot/menus", title: "Menus", context: "Stockpot" },
    { test: (p) => p === "/stockpot/signs", title: "Signs & labels", context: "Stockpot" },
  ];
  const hit = map.find((m) => m.test(pathname));
  const title = hit?.title ?? "KitchFix";
  const context = hit?.context;
  return (
    <>
      <h1>{title}</h1>
      {context ? <span className="kf-topbar__context">{context}</span> : null}
    </>
  );
}
