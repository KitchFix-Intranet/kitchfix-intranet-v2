"use client";

// BackLink - one control that says where it goes. Three shapes of
// "back":
//
//   library       -> the Library bookcase. Default.
//   search        -> the Library bookcase with the viewer's search
//                    term preserved (?q=...). Set when the current
//                    URL has `?q=` or `?from=search`.
//   document      -> the previous document, when the viewer followed
//                    an in-text link. Set when the URL carries
//                    `?from=/library/<docId>`.
//
// The address bar and browser Back AGREE: we push with
// `router.push`, so the browser's own Back goes where this control
// goes. On a cold-pasted link (no history entry we control), both
// go to the Library.
//
// Nothing personal lives in the address: `from` is a /library path,
// `q` is whatever the user typed in the search field.

import Link from "next/link";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

type Variant = "library" | "search" | "document";

type Props = {
  // Phone-friendly: a short label is used on narrow widths. The
  // long label (e.g. "Back to search") renders on wider widths via
  // CSS; both are present in the DOM.
  longLabel?: string;
  shortLabel?: string;
};

export function BackLink({ longLabel, shortLabel }: Props) {
  const sp = useSearchParams();
  const { variant, href, derivedLong, derivedShort } = useMemo(() => {
    const spStr = sp?.toString() ?? "";
    const q = sp?.get("q") ?? "";
    const from = sp?.get("from") ?? "";
    const isDocPath = from.startsWith("/library/") && from.length > "/library/".length;
    if (isDocPath) {
      // Preserve the previous document's address verbatim.
      const safe = isSafeInternal(from);
      if (safe) {
        return {
          variant: "document" as Variant,
          href: safe,
          derivedLong: "Back to the last document",
          derivedShort: "Back",
        };
      }
    }
    if (q.length > 0 || from === "search") {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      const s = qs.toString();
      return {
        variant: "search" as Variant,
        href: s ? `/library?${s}` : "/library",
        derivedLong: "Back to search",
        derivedShort: "Back",
      };
    }
    // ignore any stray params we did not set
    void spStr;
    return {
      variant: "library" as Variant,
      href: "/library",
      derivedLong: "Back to the Library",
      derivedShort: "Library",
    };
  }, [sp]);

  const longText = longLabel ?? derivedLong;
  const shortText = shortLabel ?? derivedShort;

  return (
    <Link
      href={href}
      className={`kf-btn kf-btn--ghost kf-lb-back kf-lb-back--${variant}`}
      aria-label={longText}
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      <span className="kf-lb-back__long">{longText}</span>
      <span className="kf-lb-back__short" aria-hidden>
        {shortText}
      </span>
    </Link>
  );
}

// Keep the `from` param strictly to the Library's own paths. Any
// other value (`https://...`, an admin path, etc.) is discarded so
// the back control cannot be re-pointed off-Library by a pasted
// link.
function isSafeInternal(s: string): string | null {
  if (!s.startsWith("/library/")) return null;
  // No colon, no protocol smuggling, no newline.
  if (/[\s:?]/.test(s)) return null;
  // Deny the suggestions page - it is not something a reader goes
  // "back to".
  if (s === "/library/suggestions") return null;
  return s;
}
