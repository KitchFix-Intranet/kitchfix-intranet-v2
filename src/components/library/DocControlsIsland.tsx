"use client";

// On-page island that mounts the three panels (Details, Share,
// Suggest an edit) and listens for the top-bar toolbar's custom
// events. Lives next to the article so the panels render over the
// reading surface, and Escape / outside-click / focus-trap all run
// here.
//
// Focus trap + initial focus:
//   - On open, focus moves to the panel's first focusable control
//     (close button is the universal fallback).
//   - Tab is trapped inside the panel while open.
//   - On close, focus returns to the control that opened the
//     panel. For the top-bar toolbar the opening control is picked
//     up from document.activeElement when the event fires; for the
//     end-of-section "Suggest an edit" links the opener passes its
//     element id in the event detail so we can refocus it.
//
// Draft: Suggest an edit keeps a per-device draft in localStorage
// keyed by doc_id. Cleared on successful send or on Discard. The
// draft lives on the device only; the server never sees it until
// the reader presses Send.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { X, Copy, Mail, MessageSquare, Share2, Check } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import {
  DOC_TOOL_EVENT,
  type DocToolEventDetail,
} from "./docToolEvents";
import type { OutlineItem } from "@/lib/academy/outline";

type Facts = {
  // Full set of "About" facts. Shown in the Details panel; the
  // wide-width About column on the right is server-rendered and
  // shows the subset. See `DocPage` for the subset.
  id: string;
  title: string;
  version: string | null;
  status: string;
  owner: string | null;
  approver: string | null;
  kind: string | null;
  shelf: string | null;
  effective_date: string | null;
  last_reviewed: string | null;
  next_review: string | null;
  hasEn: boolean;
  hasEs: boolean;
  spanishHref: string | null;
};

type Props = {
  docId: string;
  docTitle: string;
  outline: OutlineItem[];
  facts: Facts;
};

type PanelKind = "details" | "share" | "suggest" | null;

type SuggestDraft = {
  issueText: string;
  suggestedText: string;
  sectionAnchor: string;
  wordingOpen: boolean;
};

const DRAFT_KEY_PREFIX = "kf-lb-sug:";
const ISSUE_TEXT_MAX = 4000;
const SUGGESTED_TEXT_MAX = 8000;

export function DocControlsIsland({ docId, docTitle, outline, facts }: Props) {
  const [panel, setPanel] = useState<PanelKind>(null);
  const [initialSection, setInitialSection] = useState<{ anchor: string; text: string } | null>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Listen for the toolbar's events. Attach a data-attribute on the
  // document root so an e2e test can wait for the listener to be
  // registered before it clicks a toolbar control; without this the
  // click can fire before the window listener binds and the event
  // is lost. Non-fatal when document is undefined (SSR).
  //
  // Also delegate clicks on the per-section "Suggest an edit"
  // buttons inside the article body (they live inside the server-
  // rendered dangerouslySetInnerHTML so React is not managing their
  // handlers; a document-level click delegator picks them up
  // regardless of mount order).
  useEffect(() => {
    function onEvt(e: Event) {
      const ce = e as CustomEvent<DocToolEventDetail>;
      if (!ce.detail) return;
      returnRef.current = (document.activeElement as HTMLElement) ?? null;
      setInitialSection(ce.detail.section ?? null);
      setPanel(ce.detail.kind);
    }
    function onBodyClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const sec = target.closest<HTMLElement>("[data-kf-sec-anchor]");
      if (!sec) return;
      const anchor = sec.getAttribute("data-kf-sec-anchor") || "";
      const text = sec.getAttribute("data-kf-sec-text") || "";
      if (!anchor) return;
      e.preventDefault();
      returnRef.current = sec;
      setInitialSection({ anchor, text });
      setPanel("suggest");
    }
    window.addEventListener(DOC_TOOL_EVENT, onEvt as EventListener);
    document.addEventListener("click", onBodyClick);
    try {
      document.documentElement.setAttribute("data-lb-doc-ready", "1");
    } catch {
      // non-fatal
    }
    return () => {
      window.removeEventListener(DOC_TOOL_EVENT, onEvt as EventListener);
      document.removeEventListener("click", onBodyClick);
      try {
        document.documentElement.removeAttribute("data-lb-doc-ready");
      } catch {
        // non-fatal
      }
    };
  }, []);

  // Escape + focus trap + initial focus.
  useEffect(() => {
    if (!panel) return;
    const panelEl = panelRef.current;
    if (!panelEl) return;
    const initial = panelEl.querySelector<HTMLElement>("[data-initial-focus]")
      ?? panelEl.querySelector<HTMLElement>("[data-close]")
      ?? panelEl;
    // defer so the element is visible
    const t = window.setTimeout(() => initial.focus(), 20);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = panelEl!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  const close = useCallback(() => {
    setPanel(null);
    // Return focus to the opener.
    const ret = returnRef.current;
    if (ret && typeof ret.focus === "function") {
      try {
        ret.focus();
      } catch {
        // non-fatal
      }
    }
  }, []);

  // Outside-click (on the backdrop).
  const onBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) close();
    },
    [close],
  );

  if (!panel) return null;

  return (
    <div
      className="kf-lb-backdrop"
      onClick={onBackdrop}
      aria-hidden
    >
      <aside
        ref={panelRef}
        className={`kf-lb-panel kf-lb-panel--${panel}`}
        role="dialog"
        aria-modal="true"
        aria-label={labelFor(panel)}
      >
        <PanelHeader title={labelFor(panel)} onClose={close} />
        {panel === "details" ? (
          <DetailsBody facts={facts} />
        ) : panel === "share" ? (
          <ShareBody
            docId={docId}
            docTitle={docTitle}
            outline={outline}
            initialSection={initialSection}
          />
        ) : (
          <SuggestBody
            docId={docId}
            docTitle={docTitle}
            outline={outline}
            facts={facts}
            initialSection={initialSection}
            onSent={close}
          />
        )}
      </aside>
    </div>
  );
}

function labelFor(k: Exclude<PanelKind, null>): string {
  if (k === "details") return "Details";
  if (k === "share") return "Share";
  return "Suggest an edit";
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="kf-lb-panel__head">
      <h2 className="kf-lb-panel__title">{title}</h2>
      <button
        type="button"
        className="kf-lb-panel__close"
        data-close
        onClick={onClose}
        aria-label="Close"
      >
        <X size={18} strokeWidth={1.75} aria-hidden />
      </button>
    </header>
  );
}

// -----------------------------------------------------------------
// Details
// -----------------------------------------------------------------
function DetailsBody({ facts }: { facts: Facts }) {
  return (
    <div className="kf-lb-panel__body">
      <p className="kf-lb-panel__kick">
        <strong>{facts.title}</strong>{" "}
        <span className="kf-lb-panel__kick-id">{facts.id}</span>
      </p>
      <dl className="kf-lb-panel__kv">
        <Row label="Number" value={facts.id} mono />
        <Row label="Kind" value={facts.kind || "Document"} />
        <Row label="Version" value={facts.version ?? "-"} />
        <Row label="Status" value={facts.status} />
        {facts.owner ? <Row label="Owner" value={facts.owner} /> : null}
        {facts.approver ? <Row label="Approver" value={facts.approver} /> : null}
        {facts.effective_date ? <Row label="Approved" value={facts.effective_date} /> : null}
        {facts.last_reviewed ? <Row label="Reviewed" value={facts.last_reviewed} /> : null}
        {facts.next_review ? <Row label="Next review" value={facts.next_review} /> : null}
        {facts.shelf ? <Row label="Shelf" value={facts.shelf} /> : null}
        {facts.hasEn || facts.hasEs ? (
          <Row
            label="Languages"
            value={[facts.hasEn ? "English" : null, facts.hasEs ? "Spanish" : null]
              .filter(Boolean)
              .join(", ")}
          />
        ) : null}
      </dl>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "kf-lb-panel__mono" : undefined}>{value}</dd>
    </>
  );
}

// -----------------------------------------------------------------
// Share
// -----------------------------------------------------------------
function ShareBody({
  docId,
  docTitle,
  outline,
  initialSection,
}: {
  docId: string;
  docTitle: string;
  outline: OutlineItem[];
  initialSection: { anchor: string; text: string } | null;
}) {
  const [section, setSection] = useState<string>(initialSection?.anchor ?? "");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const url = useMemo(() => {
    if (typeof window === "undefined") {
      // SSR safety (the island is "use client", but the first
      // render still happens on the server). Use a relative
      // address; the client will overwrite on hydrate.
      return section ? `/library/${docId}#${section}` : `/library/${docId}`;
    }
    const origin = window.location.origin;
    return section
      ? `${origin}/library/${docId}#${section}`
      : `${origin}/library/${docId}`;
  }, [docId, section]);

  const secOptions = useMemo(
    () => outline.filter((o) => o.level === 1).map((o) => ({ anchor: o.anchor, text: o.text })),
    [outline],
  );
  const hasSections = secOptions.length > 0;
  const currentSectionText = secOptions.find((s) => s.anchor === section)?.text ?? null;

  const subject = `${docTitle} (${docId})`;
  const bodyText = `${subject}${currentSectionText ? `, ${currentSectionText}` : ""}, in the KitchFix Library: ${url}`;

  const onCopy = useCallback(async () => {
    const value = url;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        inputRef.current?.select();
        document.execCommand("copy");
      }
      setCopied(true);
      toast("Link copied.");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fall back: select the input so the reader can copy it.
      inputRef.current?.select();
      toast("This browser would not copy. The link is selected: press Cmd+C or Ctrl+C.", { tone: "block" });
    }
  }, [url]);

  const onShareSheet = useCallback(async () => {
    if (!("share" in navigator) || typeof navigator.share !== "function") return;
    try {
      await navigator.share({ title: subject, text: bodyText, url });
    } catch {
      // The user cancelled, or the host refused. Non-fatal.
    }
  }, [subject, bodyText, url]);

  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="kf-lb-panel__body">
      <p className="kf-lb-panel__kick">
        <strong>{docTitle}</strong>{" "}
        <span className="kf-lb-panel__kick-id">{docId}</span>
      </p>
      {hasSections ? (
        <label className="kf-lb-tick">
          <input
            type="checkbox"
            checked={section.length > 0}
            onChange={(e) => {
              const v = e.currentTarget.checked;
              setSection(v ? (initialSection?.anchor ?? secOptions[0].anchor) : "");
            }}
          />
          <span>
            Share just this part
            {initialSection?.text ? ` (${initialSection.text})` : ""}
          </span>
        </label>
      ) : null}
      {hasSections && section.length > 0 ? (
        <label className="kf-lb-field">
          <span className="kf-lb-field__l">Which part</span>
          <select
            className="kf-lb-field__ctl"
            value={section}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setSection(v);
            }}
          >
            {secOptions.map((o) => (
              <option key={o.anchor} value={o.anchor}>
                {o.text}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="kf-lb-field">
        <span className="kf-lb-field__l">Link</span>
        <input
          ref={inputRef}
          className="kf-lb-field__ctl"
          readOnly
          value={url}
          data-initial-focus
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      <div className="kf-lb-share">
        <button
          type="button"
          className={`kf-btn kf-btn--primary kf-lb-share__ctl${copied ? " is-copied" : ""}`}
          onClick={onCopy}
          aria-label={copied ? "Link copied" : "Copy link"}
        >
          {copied ? (
            <Check size={16} strokeWidth={1.75} aria-hidden />
          ) : (
            <Copy size={16} strokeWidth={1.75} aria-hidden />
          )}
          <span>{copied ? "Link copied" : "Copy link"}</span>
        </button>
        <a
          className="kf-btn kf-btn--line kf-lb-share__ctl"
          href={`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`}
        >
          <Mail size={16} strokeWidth={1.75} aria-hidden />
          <span>Email</span>
        </a>
        <a
          className="kf-btn kf-btn--line kf-lb-share__ctl"
          href={`sms:?&body=${encodeURIComponent(bodyText)}`}
        >
          <MessageSquare size={16} strokeWidth={1.75} aria-hidden />
          <span>Text</span>
        </a>
        {canNativeShare ? (
          <button
            type="button"
            className="kf-btn kf-btn--line kf-lb-share__ctl"
            onClick={onShareSheet}
          >
            <Share2 size={16} strokeWidth={1.75} aria-hidden />
            <span>More</span>
          </button>
        ) : null}
      </div>
      <p className="kf-lb-note">
        Paste the link into Slack, a text, or an email. The link carries no
        access with it - whoever opens it needs their own sign-in, and the
        Library decides what they see.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------
// Suggest an edit
// -----------------------------------------------------------------
function SuggestBody({
  docId,
  docTitle,
  outline,
  facts,
  initialSection,
  onSent,
}: {
  docId: string;
  docTitle: string;
  outline: OutlineItem[];
  facts: Facts;
  initialSection: { anchor: string; text: string } | null;
  onSent: () => void;
}) {
  const router = useRouter();
  const secOptions = useMemo(
    () => outline.filter((o) => o.level === 1).map((o) => ({ anchor: o.anchor, text: o.text })),
    [outline],
  );

  // Read a half-written draft from localStorage on mount.
  const [draft, setDraft] = useState<SuggestDraft>(() => {
    if (typeof window === "undefined") {
      return { issueText: "", suggestedText: "", sectionAnchor: initialSection?.anchor ?? "", wordingOpen: false };
    }
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY_PREFIX + docId);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SuggestDraft>;
        return {
          issueText: parsed.issueText ?? "",
          suggestedText: parsed.suggestedText ?? "",
          sectionAnchor: parsed.sectionAnchor ?? (initialSection?.anchor ?? ""),
          wordingOpen: parsed.wordingOpen ?? false,
        };
      }
    } catch {
      // ignore
    }
    return { issueText: "", suggestedText: "", sectionAnchor: initialSection?.anchor ?? "", wordingOpen: false };
  });
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Persist draft on change. Clear on successful send or Discard.
  useEffect(() => {
    try {
      if (
        draft.issueText.length === 0 &&
        draft.suggestedText.length === 0 &&
        draft.sectionAnchor.length === 0
      ) {
        window.localStorage.removeItem(DRAFT_KEY_PREFIX + docId);
      } else {
        window.localStorage.setItem(
          DRAFT_KEY_PREFIX + docId,
          JSON.stringify(draft),
        );
      }
    } catch {
      // Private mode / quota exceeded - non-fatal.
    }
  }, [docId, draft]);

  const canSend = draft.issueText.trim().length > 0 && !sending;

  const discard = () => {
    setDraft({ issueText: "", suggestedText: "", sectionAnchor: initialSection?.anchor ?? "", wordingOpen: false });
    setErr(null);
    try {
      window.localStorage.removeItem(DRAFT_KEY_PREFIX + docId);
    } catch {
      // non-fatal
    }
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setErr(null);
    try {
      const res = await fetch("/api/academy/library/suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docId,
          issueText: draft.issueText.trim(),
          sectionKey: draft.sectionAnchor || null,
          suggestedText:
            draft.wordingOpen && draft.suggestedText.trim().length > 0
              ? draft.suggestedText.trim()
              : null,
        }),
      });
      if (res.ok) {
        // Clear the draft, close, and tell the reader what happens next.
        try {
          window.localStorage.removeItem(DRAFT_KEY_PREFIX + docId);
        } catch {
          // non-fatal
        }
        toast(
          `Suggestion sent to ${facts.owner ?? "the owner"}. Nothing in the document changes until they publish.`,
        );
        setSending(false);
        onSent();
        // Keep the reader where they were - no navigation needed.
        router.refresh();
        return;
      }
      // Failure - leave the draft in place so Try again works.
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        // ignore
      }
      const code = (payload as { error?: string } | null)?.error ?? "server_error";
      setErr(messageForError(code));
    } catch {
      setErr("The note did not send. Check your connection and try again. Your words are still here.");
    } finally {
      setSending(false);
    }
  };

  // When a section is currently active (either prefilled or the
  // one the reader just picked), the "Write the new wording" UI is
  // available. With no section, it is not (there is no part to
  // rewrite).
  const sectionTitle = useMemo(
    () => secOptions.find((s) => s.anchor === draft.sectionAnchor)?.text ?? null,
    [draft.sectionAnchor, secOptions],
  );

  return (
    <div className="kf-lb-panel__body">
      <p className="kf-lb-panel__kick">
        <strong>{docTitle}</strong>{" "}
        <span className="kf-lb-panel__kick-id">
          {docId}, version {facts.version ?? "-"}
        </span>
      </p>
      <label className="kf-lb-field">
        <span className="kf-lb-field__l">Which part</span>
        <select
          className="kf-lb-field__ctl"
          value={draft.sectionAnchor}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDraft((d) => ({ ...d, sectionAnchor: v, wordingOpen: v ? d.wordingOpen : false }));
          }}
          data-initial-focus
        >
          <option value="">The whole document</option>
          {secOptions.map((o) => (
            <option key={o.anchor} value={o.anchor}>
              {o.text}
            </option>
          ))}
        </select>
      </label>
      <label className="kf-lb-field">
        <span className="kf-lb-field__l">What should change, and why</span>
        <textarea
          className="kf-lb-field__ctl kf-lb-field__ctl--ta"
          rows={5}
          maxLength={ISSUE_TEXT_MAX}
          value={draft.issueText}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDraft((d) => ({ ...d, issueText: v }));
          }}
          placeholder=""
        />
        <span className="kf-lb-field__count">
          {draft.issueText.length} / {ISSUE_TEXT_MAX}
        </span>
      </label>
      {draft.sectionAnchor.length > 0 ? (
        <div className="kf-lb-field">
          <button
            type="button"
            className="kf-btn kf-btn--ghost"
            onClick={() => setDraft((d) => ({ ...d, wordingOpen: !d.wordingOpen }))}
            aria-expanded={draft.wordingOpen}
            aria-controls="kf-lb-sug-wording"
          >
            {draft.wordingOpen ? "Hide the new wording" : "Write the new wording (optional)"}
          </button>
          {draft.wordingOpen ? (
            <div id="kf-lb-sug-wording" className="kf-lb-wording">
              <span className="kf-lb-field__l">
                Your wording for &quot;{sectionTitle}&quot;
              </span>
              <textarea
                className="kf-lb-field__ctl kf-lb-field__ctl--ta"
                rows={6}
                maxLength={SUGGESTED_TEXT_MAX}
                value={draft.suggestedText}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setDraft((d) => ({ ...d, suggestedText: v }));
                }}
              />
              <span className="kf-lb-field__count">
                {draft.suggestedText.length} / {SUGGESTED_TEXT_MAX}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {err ? (
        <p className="kf-lb-err" role="alert">
          {err}
        </p>
      ) : null}
      <p className="kf-lb-note">
        It goes to {facts.owner ?? "the owner"}, with your name. Nothing in the
        document changes until they publish.
      </p>
      <div className="kf-lb-panel__foot">
        <button
          type="button"
          className="kf-btn kf-btn--primary"
          onClick={send}
          disabled={!canSend}
        >
          {sending ? "Sending..." : "Send"}
        </button>
        <button
          type="button"
          className="kf-btn kf-btn--ghost"
          onClick={discard}
          disabled={sending || (draft.issueText.length === 0 && draft.suggestedText.length === 0)}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function messageForError(code: string): string {
  switch (code) {
    case "not_found":
      return "The document is not available.";
    case "section_missing":
      return "That section is no longer in the document. Pick another part and try again.";
    case "text_empty":
      return "Write a note before sending.";
    case "text_too_long":
      return "The note is too long. Trim it and try again.";
    case "rate_limited":
      return "That is a lot of notes in a short time. Give it a minute and try again.";
    case "unauth":
      return "Your sign-in has timed out. Reload the page and sign in again.";
    default:
      return "The note did not send. Your words are still here. Try again.";
  }
}
