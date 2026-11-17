// Map the read model's IconName to a lucide-react glyph.

import {
  Lock, Check, Pencil, Ban, Minus, Clock, Flag,
  CircleDashed, TriangleAlert, Send, House,
} from "lucide-react";
import type { IconName } from "@/lib/sc/calendar/types";

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  switch (name) {
    case "lock":          return <Lock size={size} strokeWidth={1.5} aria-hidden />;
    case "check":         return <Check size={size} strokeWidth={1.75} aria-hidden />;
    case "pencil":        return <Pencil size={size} strokeWidth={1.5} aria-hidden />;
    case "ban":           return <Ban size={size} strokeWidth={1.5} aria-hidden />;
    case "minus":         return <Minus size={size} strokeWidth={1.75} aria-hidden />;
    case "clock":         return <Clock size={size} strokeWidth={1.5} aria-hidden />;
    case "flag":          return <Flag size={size} strokeWidth={1.5} aria-hidden />;
    case "circle-dashed": return <CircleDashed size={size} strokeWidth={1.5} aria-hidden />;
    case "triangle-alert":return <TriangleAlert size={size} strokeWidth={1.5} aria-hidden />;
    case "send":          return <Send size={size} strokeWidth={1.5} aria-hidden />;
    case "house":         return <House size={size} strokeWidth={1.5} aria-hidden />;
  }
}
