"use client";

// T4b-1 (2026-11-14). Person strip shown at the top of What,
// Details and Check sheets. Renders the second line
// "<title> · <club>" per T4a.1 Part 0 #2.

export function SheetAbout({
  person,
  onChange,
}: {
  person: { display_name: string; title?: string | null; site_name?: string | null };
  onChange?: () => void;
}) {
  const ini = (person.display_name || "?")
    .split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();
  const subParts = [person.title ?? "", person.site_name ?? ""]
    .map((s) => (s ?? "").trim()).filter(Boolean);
  const sub = subParts.join(" · ");
  return (
    <div className="kf-pe-about">
      <span className="kf-pe-ava" aria-hidden>{ini}</span>
      <span className="kf-pe-about__who">
        <b data-about="name">{person.display_name}</b>
        {sub ? <small data-about="role">{sub}</small> : null}
      </span>
      {onChange ? (
        <button type="button" className="kf-btn kf-btn--ghost" onClick={onChange}>Change</button>
      ) : null}
    </div>
  );
}
