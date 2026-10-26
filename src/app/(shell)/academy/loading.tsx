// /academy loading. Shape-matched: desktop band (128), four 72-px rows.
import { Band, Block } from "@/components/ui/Skeleton";
import "@/components/academy/academy.css";

export default function Loading() {
  return (
    <div className="kf-sheet">
      <div className="kf-only-desktop">
        <Band />
      </div>
      <ul
        className="kf-todo-list"
        style={{ listStyle: "none", margin: 0, padding: 0 }}
        aria-label="Loading list"
      >
        <li>
          <Block height={72} radius={0} />
        </li>
        <li>
          <Block height={72} radius={0} />
        </li>
        <li>
          <Block height={72} radius={0} />
        </li>
        <li>
          <Block height={72} radius={0} />
        </li>
      </ul>
    </div>
  );
}
