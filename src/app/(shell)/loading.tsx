// Home loading. Renders inside the shell (rail + topbar visible during the
// fallback) because it lives under (shell)/. Heights match the content so
// the shell does not jump when Home resolves.
import { Band, Block } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <>
      <div className="kf-only-desktop" style={{ marginBottom: "var(--sp-sp-5)" }}>
        <Band />
      </div>
      <ul
        className="kf-only-desktop"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "var(--sp-sp-4)",
        }}
        aria-hidden
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i}>
            <Block height={116} radius={14} />
          </li>
        ))}
      </ul>
      <div className="kf-only-phone" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-4)" }} aria-hidden>
        <Block height={48} />
        <Block height={32} width="60%" />
        <Block height={56} />
        <Block height={120} />
        <Block height={260} />
      </div>
    </>
  );
}
