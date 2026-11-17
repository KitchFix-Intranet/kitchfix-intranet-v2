"use client";

// Invoices toolbar - filter group (aria-pressed), many-site select,
// search input, "?" button. Client-only because of its handlers.
//
// URL state is the single source of truth: every action pushes a
// new address, there is no local "selected" mirror. That is what
// keeps Back / Forward honest.

import { useRouter, usePathname } from "next/navigation";
import { useRef, useState, useCallback } from "react";
import { HelpCircle, Search } from "lucide-react";
import type { ChipCounts, FilterKey, SiteFixCounts, SiteNavItem } from "@/lib/invoices/types";
import { StatusHelpDialog } from "./StatusHelpDialog";
import { buildListHref } from "./hrefs";

export function Toolbar({
  show,
  q,
  site,
  inv,
  manySites,
  sites,
  chipCounts,
  siteFixCounts,
  fixWord,
  asParam,
}: {
  show: FilterKey;
  q: string | null;
  site: string | null;
  inv: string | null;
  manySites: boolean;
  sites: readonly SiteNavItem[];
  chipCounts: ChipCounts;
  siteFixCounts: SiteFixCounts;
  fixWord: string;
  asParam: string | null;
}) {
  const buildHref = (overrides: Partial<Parameters<typeof buildListHref>[0]>) =>
    buildListHref({ show, q, site, inv, more: 1, asParam, ...overrides });
  const router = useRouter();
  const pathname = usePathname();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpBtnRef = useRef<HTMLButtonElement | null>(null);

  const chips: { key: FilterKey; label: string; count: number }[] = [
    { key: "all",  label: "All",       count: chipCounts.all },
    { key: "fix",  label: fixWord,     count: chipCounts.fix },
    { key: "acct", label: "With accounting", count: chipCounts.acct },
  ];

  const onSearchSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("q") as HTMLInputElement | null;
    const value = input?.value.trim() ?? "";
    router.push(buildHref({ q: value || null, more: 1 }));
  }, [router, buildHref]);

  const onSiteChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.currentTarget.value;
    router.push(buildHref({ site: next || null, more: 1 }));
  }, [router, buildHref]);

  return (
    <div className="kf-invoices-toolbar" role="toolbar" aria-label="Invoices controls">
      <div className="kf-invoices-toolbar__chips" role="group" aria-label="Filter">
        {chips.map((c) => {
          const selected = c.key === show;
          // Zero-count hidden unless "All" or currently selected.
          if (c.count === 0 && c.key !== "all" && !selected) return null;
          return (
            <button
              key={c.key}
              type="button"
              className={`kf-invoices-chip${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              onClick={() => router.push(buildHref({ show: c.key, more: 1 }))}
            >
              <span className="kf-invoices-chip__label">{c.label}</span>
              <span className="kf-invoices-chip__count" aria-label={`${c.count} items`}>
                {c.count}
              </span>
            </button>
          );
        })}
        <button
          ref={helpBtnRef}
          type="button"
          className="kf-invoices-toolbar__help"
          aria-label="What the statuses mean"
          title="What the statuses mean"
          onClick={() => setHelpOpen(true)}
        >
          <HelpCircle size={18} strokeWidth={1.5} aria-hidden />
        </button>
      </div>

      <div className="kf-invoices-toolbar__right">
        {manySites ? (
          <label className="kf-invoices-toolbar__site">
            <span className="kf-sr-only">Site</span>
            <select
              className="kf-invoices-select"
              value={site ?? ""}
              onChange={onSiteChange}
              aria-label="Choose a site"
            >
              <option value="">All {sites.length} sites</option>
              {sites.map((s) => {
                const n = siteFixCounts.byAccountKey[s.accountKey] ?? 0;
                return (
                  <option key={s.accountKey} value={s.slug}>
                    {s.accountKey}
                    {n > 0 ? ` · ${n} to fix` : ""}
                  </option>
                );
              })}
            </select>
          </label>
        ) : null}

        <form className="kf-invoices-toolbar__search" onSubmit={onSearchSubmit} role="search">
          <label className="kf-invoices-search">
            <Search size={16} strokeWidth={1.5} aria-hidden />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search vendor or invoice"
              aria-label="Search by vendor or invoice number"
              key={`${pathname}:${q ?? ""}`}
            />
          </label>
        </form>
      </div>

      {helpOpen ? (
        <StatusHelpDialog
          fixWord={fixWord}
          onClose={() => {
            setHelpOpen(false);
            helpBtnRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
