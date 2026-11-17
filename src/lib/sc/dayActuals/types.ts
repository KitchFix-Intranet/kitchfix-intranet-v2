// Shapes for the day form + its save.

import type { SiteInfo, ViewerLite } from "@/lib/sc/calendar/types";

export type ServiceUnit = "meals" | "each" | "pans" | "days" | "dollars";

export interface DrawerService {
  serviceId: string;
  serviceName: string;
  groupName: string | null;  // for section headings
  unit: ServiceUnit;
  isFlatFee: boolean;        // weekly charge
  isNonRevenue: boolean;     // "Not billed" line
  priceCents: number | null; // per-unit, effective-dated; null when not on the catalog
  // UI flags
  isProjected: boolean;      // has a sc_daily_projections row with projected_count > 0
  projectedCount: number | null;
  actualCount: number | null;  // current saved actuals, null when no row yet
  hasActualsRow: boolean;      // distinguishes "no row" from "row at 0"
  // For the invoice-line warning in the drawer ("No invoice line yet").
  hasInvoiceSlot: boolean;
  // For the "Added, not on the projections" sub-line.
  isOnProjections: boolean;
}

export interface DrawerLock {
  code: "PERIOD_LOCKED" | "WEEK_FINALIZED";
  message: string;
}

export interface DayDrawerView {
  viewer: ViewerLite;
  site: SiteInfo;
  serviceDate: string;           // YYYY-MM-DD
  dayOfWeekLong: string;
  dayDisplayDate: string;        // "Nov 17"
  // The day as the save route sees it. Zero rows when the day is empty.
  rows: DrawerService[];
  services: DrawerService[];     // all services the account has (for "Add a service")
  // Lock state. When present, the drawer renders read-only with the
  // banner; the save path will refuse too.
  lock: DrawerLock | null;
  // Day metadata.
  eventLabel: string | null;
  gameType: "DAY" | "NIGHT" | null;
  gameTime: string | null;
  // The phase that covers this day, for the chip.
  phase: string | null;
  // The day token at the moment the drawer opened. The client sends
  // this back on save; the server recomputes to detect a clash.
  dayToken: string;
  // The state the drawer renders in its chip (reuses the calendar's
  // nine-code state).
  state: string;
  stateWord: string;
  // For nav (one day back / forward).
  prevIso: string | null;
  nextIso: string | null;
  // F2 post-save focus. The next day in the SAME Monday-Sunday week
  // that still has projections and nothing entered (or part-entered).
  // Null when there is no such day; the drawer closes after save
  // instead of advancing.
  nextDayToEnterIso: string | null;
}

// Save path.

export interface SaveEntry {
  serviceId: string;
  actualCount: number;
}

export type SaveResult =
  | { ok: true; written: number; dayToken: string; state: string; stateWord: string }
  | { ok: false; code: "INVALID_COUNT"; serviceId: string; message: string }
  | { ok: false; code: "UNAUTHENTICATED" }
  | { ok: false; code: "NOT_AUTHORIZED"; message: string }
  | { ok: false; code: "PERIOD_LOCKED"; lockedDates: string[]; message: string }
  | { ok: false; code: "WEEK_FINALIZED"; finalizedWeeks: { weekStart: string; status: string }[]; message: string }
  | { ok: false; code: "DAY_CHANGED"; theirRows: TheirRow[]; dayToken: string }
  | { ok: false; code: "SERVER_ERROR"; message: string };

export interface TheirRow {
  serviceId: string;
  serviceName: string;
  actualCount: number;
  updatedBy: string | null;
  updatedAt: string | null;
}
