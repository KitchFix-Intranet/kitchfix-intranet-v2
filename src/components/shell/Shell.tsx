"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  ArrowLeft,
  Soup,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  CheckCircle2,
  ListTodo,
} from "lucide-react";
import { AccountMenu } from "./AccountMenu";
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

// Stockpot-level nav.
const STOCKPOT_NAV: NavItem[] = [
  { href: "/stockpot/ingredients", label: "Ingredients", Icon: Soup },
  { href: "/stockpot/recipes", label: "Recipes", Icon: FileText },
  { href: "/stockpot/menus", label: "Menus", Icon: LayoutGrid },
  { href: "/stockpot/signs", label: "Signs & labels", Icon: ImageIcon },
];

// Academy-level nav. Train B ships To do + Done. Team and Admin arrive in
// later trains; do not add dead items here. R-AC5: the shell-level phone
// tabbar stays Home / Stockpot / People / Ops / Menu; the Academy level
// does NOT get its own phone tabbar.
const ACADEMY_NAV: NavItem[] = [
  { href: "/academy", label: "To do", Icon: ListTodo },
  { href: "/academy/done", label: "Done", Icon: CheckCircle2 },
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
function isAcademyRoute(pathname: string): boolean {
  return pathname === "/academy" || pathname.startsWith("/academy/");
}
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

type Props = {
  children: ReactNode;
  topbar: ReactNode;
  email: string;
  name: string;
  title: string;
  crumb?: ReactNode;
  // Count of remaining Academy requirements for the viewer. The server
  // layout computes this only on academy routes (one extra query);
  // elsewhere it is null and the badge never renders.
  todoCount?: number | null;
};

export function Shell({ children, topbar, email, name, title, crumb, todoCount = null }: Props) {
  const pathname = usePathname();
  const inStockpot = isStockpotRoute(pathname);
  const inAcademy = isAcademyRoute(pathname);
  const nav = inStockpot ? STOCKPOT_NAV : inAcademy ? ACADEMY_NAV : SHELL_NAV;
  // R-AC5: phone tabbar stays shell-level even inside Academy.
  const phoneTabs = inStockpot ? PHONE_STOCKPOT_TABS : PHONE_SHELL_TABS;

  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Topbar progress state. "idle" at first paint (no hydration mismatch).
  // Click on any rail nav Link -> "busy"; pathname settles -> "complete" for
  // a tick then back to "idle". A 3500ms safety timeout clears a stuck
  // same-route click.
  const [busy, setBusy] = useState<"idle" | "busy" | "complete">("idle");
  const navStartRef = useRef<string | null>(null);
  const safetyRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("kf.rail.collapsed");
      if (raw === "1") setCollapsed(true);
    } catch {
      // non-fatal
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

  // Settle the progress bar when the pathname changes to the target the
  // nav Link started us toward, or when a same-route click clears it.
  useEffect(() => {
    if (busy !== "busy") return;
    if (navStartRef.current && pathname === navStartRef.current) {
      navStartRef.current = null;
      setBusy("complete");
      const t = window.setTimeout(() => setBusy("idle"), 360);
      return () => window.clearTimeout(t);
    }
  }, [busy, pathname]);

  function markNavStart(href: string) {
    const target = href.startsWith("/") ? href.split("?")[0] : null;
    if (!target) return;
    if (target === pathname) return;
    navStartRef.current = target;
    setBusy("busy");
    if (safetyRef.current) window.clearTimeout(safetyRef.current);
    safetyRef.current = window.setTimeout(() => {
      navStartRef.current = null;
      setBusy("idle");
    }, 3500);
  }

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
                src="/brand/kitchfix-white-circle.svg"
                alt="KitchFix"
                className="kf-rail__logo kf-rail__logo--circle"
              />
            ) : (
              <img
                src="/brand/kitchfix-white-horizontal.svg"
                alt="KitchFix"
                className="kf-rail__logo kf-rail__logo--horizontal"
              />
            )}
          </span>
          <button
            type="button"
            className="kf-rail__close kf-only-phone"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        {inStockpot || inAcademy ? (
          <>
            <Link href="/" className="kf-rail__back" onClick={() => markNavStart("/")}>
              <span className="kf-rail__back-ico" aria-hidden>
                <ArrowLeft size={16} strokeWidth={1.5} />
              </span>
              <span className="kf-rail__back-label">All tools</span>
            </Link>
            <div className="kf-rail__section" aria-hidden>
              <span>{inStockpot ? "Stockpot" : "Academy"}</span>
            </div>
          </>
        ) : null}

        <nav className="kf-rail__nav">
          <ul>
            {nav.map(({ href, label, Icon, liveDot }) => {
              // Rail count badge: Academy To do only, when > 0.
              const showCount =
                inAcademy && href === "/academy" && typeof todoCount === "number" && todoCount > 0;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    className={`kf-rail__item${isActive(pathname, href) ? " kf-rail__item--active" : ""}`}
                    title={label}
                    onClick={() => markNavStart(href)}
                  >
                    <Icon size={20} strokeWidth={1.5} />
                    <span className="kf-rail__label">{label}</span>
                    {liveDot ? <span className="kf-rail__dot" aria-label="live" /> : null}
                    {showCount ? (
                      <span className="kf-rail__count" aria-label={`${todoCount} to do`}>
                        {todoCount}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="kf-rail__foot">
          <AccountMenu email={email} name={name} slim={collapsed} />
        </div>
      </aside>

      <button
        type="button"
        className="kf-rail__notch kf-only-desktop"
        onClick={() => setCollapsed((v) => !v)}
        aria-label={collapsed ? "Expand rail" : "Collapse rail"}
        title={collapsed ? "Expand rail" : "Collapse rail"}
      >
        <span className="kf-rail__notch-inner" aria-hidden>
          <ChevronLeft size={16} strokeWidth={1.5} />
        </span>
      </button>

      {drawerOpen ? (
        <div
          className="kf-rail__backdrop kf-only-phone"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      ) : null}

      <div className="kf-main">
        <header
          className={`kf-topbar${busy === "busy" ? " is-busy" : busy === "complete" ? " is-busy-complete" : ""}`}
        >
          <button
            type="button"
            className="kf-topbar__burger kf-only-phone"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <MenuIcon size={20} strokeWidth={1.5} />
          </button>
          <div className="kf-topbar__title">
            <h1>{title}</h1>
            {crumb ? <span className="kf-topbar__crumb">{crumb}</span> : null}
          </div>
          <div className="kf-topbar__actions">{topbar}</div>
          <div className="kf-topbar__progress" aria-hidden />
        </header>
        <main className="kf-canvas">{children}</main>
      </div>

      <nav className="kf-tabbar kf-only-phone" aria-label="Section">
        {phoneTabs.map((t) =>
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
              onClick={() => markNavStart(t.href)}
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
