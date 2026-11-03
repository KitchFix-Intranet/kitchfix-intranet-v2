"use client";

// Viewport-fixed "Confirm this group" shortcut for long review groups.
// Polish 5 (2026-11-02). The L item deferred from Polish 4.
//
// What this is NOT: card-scoped `position: sticky; bottom: 0` on
// .kf-rvc__actions. That exact approach was tried on an earlier arc
// and reverted on 2026-10-30 - .kf-rvc is overflow:clip, so a sticky
// descendant clamps to the card's bottom and rendered the bar ABOVE
// its own rows on 169 of 171 cards. See review.css:321-327. This
// component sidesteps the clip entirely by rendering at the
// document-body level with position:fixed, bound to the group
// currently in the viewport via a scroll scan - no card-scoped
// sticky, no change to .kf-rvc's overflow.
//
// Architecture:
//   - StickyConfirmProvider wraps the review-queue list. Owns a Map
//     of group-key -> registration (selectedCount, canConfirm,
//     busy, groupName, confirmChecked). ReviewActions registers via
//     useStickyConfirmRegister on mount and re-registers on every
//     render where the registered fields change.
//   - StickyConfirmBar sits inside the provider but outside the list,
//     at the island root. On scroll/resize it scans the DOM for the
//     top-most .kf-rvc card currently intersecting the viewport,
//     and whether that card's own .kf-rvc__actions bar is visible.
//     When the actions bar is OFF-screen and the group has
//     selections, the fixed bar shows the group's name + selected
//     count + a Confirm button that calls the registered handler.
//     Byte-for-byte the same handler ReviewActions uses - no
//     duplicated logic.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type StickyConfirmEntry = {
  groupKey: string;
  groupName: string;
  selectedCount: number;
  memberCount: number;
  canConfirm: boolean;
  busy: boolean;
  // Fired by the sticky bar's Confirm button. Must be the exact same
  // handler the inline action bar calls - do not re-implement confirm.
  confirmChecked: () => Promise<void> | void;
};

type RegistryValue = {
  snapshot: Map<string, StickyConfirmEntry>;
  version: number;
  register: (entry: StickyConfirmEntry) => void;
  unregister: (groupKey: string) => void;
};

const StickyConfirmContext = createContext<RegistryValue | null>(null);

export function StickyConfirmProvider({ children }: { children: ReactNode }) {
  // Store entries in a ref so re-registering on every ReviewActions
  // render is cheap (no setState churn across siblings). A separate
  // version counter triggers StickyConfirmBar to re-scan when the
  // set of groups changes (filter / sort shuffle).
  const mapRef = useRef(new Map<string, StickyConfirmEntry>());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const register = useCallback(
    (entry: StickyConfirmEntry) => {
      const prev = mapRef.current.get(entry.groupKey);
      mapRef.current.set(entry.groupKey, entry);
      // Only bump when the set of keys actually changes - updates to
      // selectedCount / busy / canConfirm are reactive at the
      // registrant side (ReviewActions re-renders) and the bar reads
      // the ref live; no re-scan needed.
      if (!prev) bump();
    },
    [bump]
  );
  const unregister = useCallback(
    (groupKey: string) => {
      if (mapRef.current.delete(groupKey)) bump();
    },
    [bump]
  );

  const value: RegistryValue = { snapshot: mapRef.current, version, register, unregister };
  return <StickyConfirmContext.Provider value={value}>{children}</StickyConfirmContext.Provider>;
}

// ReviewActions calls this once per render with its current state.
// The entry is a plain object; the hook upserts it into the map.
// Pass `null` to skip registration (e.g. during unmount edge cases).
export function useStickyConfirmRegister(entry: StickyConfirmEntry | null): void {
  const ctx = useContext(StickyConfirmContext);
  // Re-register whenever any of the live fields change. The handler
  // itself can change identity between renders - no issue, the
  // registry just stores the latest reference.
  useEffect(() => {
    if (!ctx || !entry) return;
    ctx.register(entry);
    return () => {
      ctx.unregister(entry.groupKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ctx,
    entry?.groupKey,
    entry?.groupName,
    entry?.selectedCount,
    entry?.memberCount,
    entry?.canConfirm,
    entry?.busy,
    entry?.confirmChecked,
  ]);
}

// Where to anchor the scan: the top of the viewport (0) is where the
// topbar + sticky search sit. 80px below ignores the stuck chrome so
// we don't pick a card whose "visible" strip is just the sticky
// toolbar covering it.
const TOP_CHROME_PX = 80;

export function StickyConfirmBar() {
  const ctx = useContext(StickyConfirmContext);
  const [current, setCurrent] = useState<{ key: string; show: boolean } | null>(null);
  // Mirror of the current registered entry's live fields so the bar
  // re-renders when selection count / busy toggle. The ref-based
  // registry doesn't trigger a React re-render by itself.
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!ctx) return;
    let raf = 0;
    const scan = () => {
      const vh = window.innerHeight;
      const cards = document.querySelectorAll<HTMLElement>("[data-group-key]");
      let pickedKey: string | null = null;
      let actionsVisible = true;
      for (const card of cards) {
        const r = card.getBoundingClientRect();
        // Skip cards fully above the viewport or fully below it.
        if (r.bottom < TOP_CHROME_PX) continue;
        if (r.top > vh) break; // DOM order is top-down; nothing below qualifies either
        // This card is at least partially visible. Pick the top-most
        // (iteration order is DOM order), and inspect its actions bar.
        pickedKey = card.dataset.groupKey ?? null;
        const actions = card.querySelector<HTMLElement>(".kf-rvc__actions");
        if (!actions) {
          actionsVisible = true;
        } else {
          const ar = actions.getBoundingClientRect();
          // Visible when any part of the bar is on screen (ignoring
          // the top-chrome gutter; the inline bar is tall enough that
          // 80px of it under the sticky search still counts).
          actionsVisible = ar.top < vh && ar.bottom > TOP_CHROME_PX;
        }
        break;
      }
      setCurrent((prev) => {
        const nextShow = pickedKey != null && !actionsVisible;
        if (prev == null && !nextShow) return null;
        if (prev && pickedKey === prev.key && nextShow === prev.show) return prev;
        return pickedKey ? { key: pickedKey, show: nextShow } : null;
      });
      forceRender((n) => n + 1);
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        scan();
      });
    };
    const onResize = onScroll;
    scan();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [ctx, ctx?.version]);

  if (!ctx || !current || !current.show) return null;
  const entry = ctx.snapshot.get(current.key);
  if (!entry) return null;
  const disabled = !entry.canConfirm || entry.busy || entry.selectedCount === 0;
  return (
    <div
      className="kf-sticky-confirm"
      role="toolbar"
      aria-label={`Confirm ${entry.groupName}`}
    >
      <div className="kf-sticky-confirm__meta">
        <strong className="kf-sticky-confirm__count">
          {entry.selectedCount} of {entry.memberCount}
        </strong>
        <span className="kf-sticky-confirm__dot" aria-hidden>&middot;</span>
        <span className="kf-sticky-confirm__name" title={entry.groupName}>
          {entry.groupName}
        </span>
      </div>
      <button
        type="button"
        className="kf-btn kf-btn--primary kf-btn--sm"
        disabled={disabled}
        onClick={() => {
          void entry.confirmChecked();
        }}
      >
        {entry.busy ? "Saving..." : "Confirm"}
      </button>
    </div>
  );
}
