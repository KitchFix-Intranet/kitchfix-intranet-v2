import { Block } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-5)" }}>
      <Block height={48} />
      <div style={{ display: "flex", gap: "var(--sp-sp-3)", flexWrap: "wrap" }}>
        <Block height={64} width={264} />
        <Block height={64} width={320} />
      </div>
      <div style={{ display: "flex", gap: "var(--sp-sp-1)", flexWrap: "wrap" }}>
        <Block height={44} width={92} radius={999} />
        <Block height={44} width={92} radius={999} />
        <Block height={44} width={92} radius={999} />
        <Block height={44} width={92} radius={999} />
      </div>
      <div
        style={{
          background: "var(--sp-card)",
          border: "1px solid var(--sp-line)",
          borderRadius: "var(--sp-r-card)",
          boxShadow: "var(--sp-shadow)",
          overflow: "hidden",
        }}
      >
        <Block height={56} radius={0} />
        <Block height={36} radius={0} />
        <div style={{ padding: "18px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
          <Block height={12} />
          <Block height={12} />
          <Block height={12} />
          <Block height={12} />
          <Block height={12} />
          <Block height={12} />
          <Block height={12} />
          <Block height={12} />
        </div>
      </div>
    </div>
  );
}
