// The icon + word pair, status-coloured. One component so the "two
// signals" rule (every state carries a colour and a shape or word)
// lives in one place.

import { Icon } from "./Icon";
import type { DayTone, IconName } from "@/lib/sc/calendar/types";

export function StatusWord({
  tone, icon, word, size = 14,
}: { tone: DayTone; icon: IconName; word: string; size?: number }) {
  return (
    <span className={`kf-sc-state kf-sc-state--${tone}`}>
      <Icon name={icon} size={size} />
      <span>{word}</span>
    </span>
  );
}
