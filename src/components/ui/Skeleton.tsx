// Shared skeleton primitives. loading.tsx on each route composes these.

type Common = { className?: string; style?: React.CSSProperties };

export function Block({ height, width = "100%", radius = 10, className, style }: Common & {
  height: number;
  width?: number | string;
  radius?: number;
}) {
  return (
    <div
      className={`kf-skel${className ? ` ${className}` : ""}`}
      style={{ height, width, borderRadius: radius, ...style }}
    />
  );
}

export function Line({ width = "100%", className, style }: Common & { width?: number | string }) {
  return (
    <div
      className={`kf-skel kf-skel--line${className ? ` ${className}` : ""}`}
      style={{ width, ...style }}
    />
  );
}

export function Band({ className, style }: Common) {
  return (
    <div
      className={`kf-skel kf-skel--navy${className ? ` ${className}` : ""}`}
      style={{ height: "var(--sp-band)", borderRadius: "var(--sp-r-lg)", ...style }}
    />
  );
}
