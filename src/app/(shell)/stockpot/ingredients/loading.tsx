// Ingredients loading. Renders inside the shell. Heights match the final
// content: band 128, tabs line 48, five tiles 118 (lead navy), two meter
// cards 420 / 464, two health cards 260.
import { Band, Block } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-5)" }}>
      <div className="kf-only-desktop"><Band /></div>
      <Block height={48} radius={0} />
      <div
        className="kf-only-desktop"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          gap: "var(--sp-sp-3)",
        }}
      >
        <Block height={118} className="kf-skel kf-skel--navy" />
        <Block height={118} />
        <Block height={118} />
        <Block height={118} />
        <Block height={118} />
      </div>
      <div
        className="kf-only-desktop"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "var(--sp-sp-4)",
        }}
      >
        <Block height={420} />
        <Block height={464} />
      </div>
      <div
        className="kf-only-desktop"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "var(--sp-sp-4)",
        }}
      >
        <Block height={260} />
        <Block height={260} />
      </div>
      <div
        className="kf-only-phone"
        style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-3)" }}
      >
        <Block height={48} />
        <Block height={48} />
        <Block height={118} />
        <Block height={118} />
        <Block height={240} />
      </div>
    </div>
  );
}
