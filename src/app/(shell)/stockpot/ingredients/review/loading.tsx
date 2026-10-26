import { Block } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-5)" }}>
      <Block height={48} />
      <Block height={44} width={360} />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-sp-3)" }}>
        <Block height={220} />
        <Block height={180} />
        <Block height={160} />
      </div>
    </div>
  );
}
