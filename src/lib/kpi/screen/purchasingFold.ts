// src/lib/kpi/screen/purchasingFold.ts
//
// Train 2d-1. REWRITE from v1:
//   src/app/kpi/overview/components/PurchasingFold.js (608 lines)
//   src/app/kpi/overview/components/PurchasingLedger.js (472 lines)
//
// V1 mounts two folds on closed single-period:
//   variant="invoices"  - invoice_submissions + billcom + billcom_credit
//                         + upload
//   variant="cards"     - rippling_spend (coded lines only)
//
// Per-variant model shape:
//   transactions - per source_bill_id group, with bucket amounts
//   foot         - per-bucket period totals (food / packaging / vehicle / billed)
//   week_bands   - per-week rows (ordered in-progress -> settled desc -> ahead)
//
// Bucket rule (R-150 revised 2026-09-22):
//   3200.*  -> food
//   3400.*  -> packaging
//   3500.*  -> vehicle
//   13xx    -> billed
//   5xxx    -> sga (dropped from columns)
//
// Closed-range scope: in_progress / ahead week states still exist in
// principle for late-posted invoices but closed single-period sees
// all four weeks `settled`; render paths respect the state so the
// model stays correct whichever side the week lives on.

import { weekStartsInRange } from "@/lib/kpi/labor/periods";
import type { FiscalYear } from "@/lib/kpi/shared/fiscalYear";
import { formatMoneyWhole, fmtWeekRange } from "./formatting";

export type PurchasingVariant = "invoices" | "cards";

export type PurchasingBucketTotals = {
  food: number;
  packaging: number;
  vehicle: number;
  billed: number;
  total: number;
};

export type PurchasingTxn = {
  key: string;
  source: string;
  source_bill_id: string;
  vendor: string;
  type: string | null;
  status: string | null;
  invoice_number: string | null;
  txn_date: string | null;
  sga_removed: number;
  food: number;
  packaging: number;
  vehicle: number;
  billed: number;
  total: number;
  person: string | null;
  has_receipt: boolean | null;
  memo: string | null;
};

export type PurchasingWeekBand = {
  week_start: string;
  week_end: string;
  state: "settled" | "in-progress" | "ahead";
  rows: PurchasingTxn[];
  food: number;
  packaging: number;
  vehicle: number;
  billed: number;
  total: number;
};

export type PurchasingFoldModel = {
  render: boolean;
  variant: PurchasingVariant;
  transactions: PurchasingTxn[];
  foot: PurchasingBucketTotals;
  week_bands: PurchasingWeekBand[];
  show_vehicle: boolean;
};

const SOURCES_INVOICES = new Set([
  "invoice_submissions",
  "billcom",
  "billcom_credit",
  "upload",
]);
const SOURCES_CARDS = new Set(["rippling_spend"]);

function round2(n: any): number {
  return Math.round(Number(n || 0) * 100) / 100;
}

function bucketOf(gl: any): "food" | "packaging" | "vehicle" | "billed" | "sga" | null {
  const s = String(gl || "").trim();
  if (!s) return null;
  if (s === "3200" || s.startsWith("3200.")) return "food";
  if (s === "3400" || s.startsWith("3400.")) return "packaging";
  if (s === "3500" || s.startsWith("3500.")) return "vehicle";
  if (s.startsWith("13")) return "billed";
  if (s.startsWith("5")) return "sga";
  return null;
}

function weekStartOf(iso: string | null, fyStartISO: string): string | null {
  if (!iso) return null;
  const t = Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
  const fyMs = Date.UTC(
    Number(fyStartISO.slice(0, 4)),
    Number(fyStartISO.slice(5, 7)) - 1,
    Number(fyStartISO.slice(8, 10)),
  );
  if (!Number.isFinite(t) || t < fyMs) return null;
  const w = Math.floor((t - fyMs) / (7 * 86400000));
  const d = new Date(fyMs + w * 7 * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function weekEndOf(weekStart: string): string {
  const t = Date.UTC(
    Number(weekStart.slice(0, 4)),
    Number(weekStart.slice(5, 7)) - 1,
    Number(weekStart.slice(8, 10)),
  );
  const d = new Date(t + 6 * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function weekState(
  weekStart: string,
  weekEnd: string,
  todayISO: string,
): "settled" | "in-progress" | "ahead" {
  if (weekEnd < todayISO) return "settled";
  if (weekStart > todayISO) return "ahead";
  return "in-progress";
}

function buildTransactions(
  rows: any[],
  variant: PurchasingVariant,
): PurchasingTxn[] {
  const groups = new Map<string, any>();
  for (const r of rows) {
    const bill = r.source_bill_id;
    if (!bill) continue;
    const key = `${r.source}|${bill}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        source: r.source,
        source_bill_id: bill,
        vendor: r.vendor || r.vendor_or_merchant || "(no vendor)",
        type: r.type || null,
        status: r.status || null,
        invoice_number: r.invoice_number || null,
        txn_date: r.txn_date,
        sga_removed: 0,
        food: 0,
        packaging: 0,
        vehicle: 0,
        billed: 0,
        hasCogs: false,
        allSga: true,
        anyLine: false,
        codedLines: 0,
        uncodedLines: 0,
        person: null,
        hasReceipt: null,
        memo: null,
      };
      groups.set(key, g);
    }
    const b = bucketOf(r.gl_line_code);
    g.anyLine = true;
    if (r.source === "rippling_spend") {
      if (r.gl_line_code) g.codedLines += 1;
      else g.uncodedLines += 1;
      if (g.person == null && r.employee_name) g.person = r.employee_name;
      if (g.hasReceipt == null && r.has_receipt != null)
        g.hasReceipt = r.has_receipt;
      if (g.memo == null && r.memo) g.memo = r.memo;
    }
    if (b === "sga") {
      /* SG&A drops from columns; sga_removed carries the total */
    } else if (b) {
      g.allSga = false;
      (g as any)[b] += Number(r.amount || 0);
      if (b === "food" || b === "packaging" || b === "vehicle" || b === "billed")
        g.hasCogs = true;
    }
    if (r.source === "invoice_submissions" && r.sga_removed_amount) {
      g.sga_removed = Math.max(g.sga_removed, Number(r.sga_removed_amount));
    }
    if (r.txn_date && (!g.txn_date || r.txn_date < g.txn_date))
      g.txn_date = r.txn_date;
  }
  const out: PurchasingTxn[] = [];
  for (const g of groups.values()) {
    if (g.allSga) continue;
    g.food = round2(g.food);
    g.packaging = round2(g.packaging);
    g.vehicle = round2(g.vehicle);
    g.billed = round2(g.billed);
    g.total = round2(g.food + g.packaging + g.vehicle + g.billed);
    if (variant === "cards" && g.codedLines === 0) continue;
    out.push({
      key: g.key,
      source: g.source,
      source_bill_id: g.source_bill_id,
      vendor: g.vendor,
      type: g.type,
      status: g.status,
      invoice_number: g.invoice_number,
      txn_date: g.txn_date,
      sga_removed: g.sga_removed,
      food: g.food,
      packaging: g.packaging,
      vehicle: g.vehicle,
      billed: g.billed,
      total: g.total,
      person: g.person,
      has_receipt: g.hasReceipt,
      memo: g.memo,
    });
  }
  return out;
}

type BuildOpts = {
  payload: any;                 // /api/kpi/purchasing response
  variant: PurchasingVariant;
  start: string;
  end: string;
  today: string;
  fy: FiscalYear;
  fyStartISO: string;
};

export function buildPurchasingFold(opts: BuildOpts): PurchasingFoldModel {
  const actuals = Array.isArray(opts.payload?.actuals)
    ? opts.payload.actuals
    : null;
  if (!actuals) {
    return {
      render: false,
      variant: opts.variant,
      transactions: [],
      foot: { food: 0, packaging: 0, vehicle: 0, billed: 0, total: 0 },
      week_bands: [],
      show_vehicle: false,
    };
  }
  const sources =
    opts.variant === "invoices" ? SOURCES_INVOICES : SOURCES_CARDS;
  const inScope = actuals.filter((r: any) => {
    if (!sources.has(r.source)) return false;
    if (opts.variant === "cards" && !r.gl_line_code) return false;
    return true;
  });

  const transactions = buildTransactions(inScope, opts.variant);

  const foot = { food: 0, packaging: 0, vehicle: 0, billed: 0, total: 0 };
  for (const t of transactions) {
    foot.food += t.food;
    foot.packaging += t.packaging;
    foot.vehicle += t.vehicle;
    foot.billed += t.billed;
  }
  foot.food = round2(foot.food);
  foot.packaging = round2(foot.packaging);
  foot.vehicle = round2(foot.vehicle);
  foot.billed = round2(foot.billed);
  foot.total = round2(foot.food + foot.packaging + foot.vehicle + foot.billed);

  const weeks = weekStartsInRange(opts.start, opts.end, opts.fy) as string[];
  const byWeek = new Map<string, PurchasingWeekBand>();
  for (const w of weeks) {
    const we = weekEndOf(w);
    byWeek.set(w, {
      week_start: w,
      week_end: we,
      state: weekState(w, we, opts.today),
      rows: [],
      food: 0,
      packaging: 0,
      vehicle: 0,
      billed: 0,
      total: 0,
    });
  }
  for (const t of transactions) {
    const w = weekStartOf(t.txn_date, opts.fyStartISO);
    const bucket = w ? byWeek.get(w) : null;
    if (!bucket) continue;
    bucket.rows.push(t);
    bucket.food += t.food;
    bucket.packaging += t.packaging;
    bucket.vehicle += t.vehicle;
    bucket.billed += t.billed;
    bucket.total += t.total;
  }
  for (const b of byWeek.values()) {
    b.rows.sort(
      (a, b) =>
        (a.txn_date || "").localeCompare(b.txn_date || "") ||
        a.vendor.localeCompare(b.vendor),
    );
    b.food = round2(b.food);
    b.packaging = round2(b.packaging);
    b.vehicle = round2(b.vehicle);
    b.billed = round2(b.billed);
    b.total = round2(b.total);
  }
  const ascending = [...byWeek.values()];
  const inProgress = ascending.find((b) => b.state === "in-progress");
  const weekBands: PurchasingWeekBand[] = inProgress
    ? [
        inProgress,
        ...ascending.filter((b) => b.state === "settled").reverse(),
        ...ascending.filter((b) => b.state === "ahead"),
      ]
    : [...ascending].reverse();

  return {
    render: transactions.length > 0,
    variant: opts.variant,
    transactions,
    foot,
    week_bands: weekBands,
    show_vehicle: foot.vehicle !== 0,
  };
}

// --- Formatter ----------------------------------------------------

export type PurchasingTxnDisplay = {
  key: string;
  vendor: string;
  type_label: string;
  number_label: string;
  food_display: string | null;
  packaging_display: string | null;
  vehicle_display: string | null;
  billed_display: string | null;
  total_display: string | null;
  sga_removed_display: string | null;
};

export type PurchasingWeekBandDisplay = {
  week_start: string;
  week_end: string;
  state: "settled" | "in-progress" | "ahead";
  date_range: string | null;
  rows: PurchasingTxnDisplay[];
  food_display: string | null;
  packaging_display: string | null;
  vehicle_display: string | null;
  billed_display: string | null;
  total_display: string | null;
};

export type PurchasingFoldDisplay = {
  render: boolean;
  variant: PurchasingVariant;
  header_summary: string | null;
  foot: {
    food_display: string | null;
    packaging_display: string | null;
    vehicle_display: string | null;
    billed_display: string | null;
    total_display: string | null;
  };
  week_bands: PurchasingWeekBandDisplay[];
  show_vehicle: boolean;
};

function typeLabel(t: PurchasingTxn): string {
  if (t.source === "invoice_submissions")
    return t.type === "credit" ? "Credit" : "Invoice";
  if (t.source === "billcom_credit") return "Credit";
  if (t.source === "billcom") return "Invoice";
  if (t.source === "upload") return "Invoice";
  if (t.source === "rippling_spend") return "Card";
  return "—";
}

function numberLabel(t: PurchasingTxn): string {
  if (t.source === "invoice_submissions")
    return t.invoice_number ? `#${t.invoice_number}` : "—";
  return t.source_bill_id ? `#${String(t.source_bill_id).slice(0, 13)}` : "—";
}

function cellOrDash(n: any): string | null {
  if (n == null) return null;
  if (Math.abs(Number(n)) < 0.005) return null;
  return formatMoneyWhole(n);
}

export function formatPurchasingFold(
  m: PurchasingFoldModel,
): PurchasingFoldDisplay {
  if (!m.render) {
    return {
      render: false,
      variant: m.variant,
      header_summary: null,
      foot: {
        food_display: null,
        packaging_display: null,
        vehicle_display: null,
        billed_display: null,
        total_display: null,
      },
      week_bands: [],
      show_vehicle: false,
    };
  }
  const n = m.transactions.length;
  const noun =
    m.variant === "invoices"
      ? `${n} ${n === 1 ? "invoice" : "invoices"}`
      : `${n} card ${n === 1 ? "charge" : "charges"}`;
  const header_summary = `${noun} · ${formatMoneyWhole(m.foot.total)}`;
  return {
    render: true,
    variant: m.variant,
    header_summary,
    foot: {
      food_display: formatMoneyWhole(m.foot.food),
      packaging_display: formatMoneyWhole(m.foot.packaging),
      vehicle_display: m.show_vehicle
        ? formatMoneyWhole(m.foot.vehicle)
        : null,
      billed_display: formatMoneyWhole(m.foot.billed),
      total_display: formatMoneyWhole(m.foot.total),
    },
    week_bands: m.week_bands.map((b): PurchasingWeekBandDisplay => ({
      week_start: b.week_start,
      week_end: b.week_end,
      state: b.state,
      date_range: fmtWeekRange(b.week_start, b.week_end),
      rows: b.rows.map((r): PurchasingTxnDisplay => ({
        key: r.key,
        vendor: r.vendor,
        type_label: typeLabel(r),
        number_label: numberLabel(r),
        food_display: cellOrDash(r.food),
        packaging_display: cellOrDash(r.packaging),
        vehicle_display: m.show_vehicle ? cellOrDash(r.vehicle) : null,
        billed_display: cellOrDash(r.billed),
        total_display: formatMoneyWhole(r.total),
        sga_removed_display:
          r.sga_removed > 0 ? formatMoneyWhole(r.sga_removed) : null,
      })),
      food_display: formatMoneyWhole(b.food),
      packaging_display: formatMoneyWhole(b.packaging),
      vehicle_display: m.show_vehicle ? formatMoneyWhole(b.vehicle) : null,
      billed_display: formatMoneyWhole(b.billed),
      total_display: formatMoneyWhole(b.total),
    })),
    show_vehicle: m.show_vehicle,
  };
}
