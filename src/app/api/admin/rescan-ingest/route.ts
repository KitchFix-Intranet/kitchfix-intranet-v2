import { NextRequest, NextResponse } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
// Same ceiling as pack-backfill and intake. The ingest itself is fast
// (a Supabase upsert on up to 1,000 rows), but the request body can
// arrive slowly from a browser POST.
export const maxDuration = 300;

// L1 §1: Route A - rescan-ingest.
//
// Writes JSONL records produced by the invoice re-scan to the
// pr_rescan_lines staging table, VERBATIM. No interpretation here;
// that is the whole point of the staging layer (0010 header: "ingest
// is dumb and idempotent"). The apply pass reads these rows.
//
// Boundaries:
//   - Does not read files from disk, the repo, or Drive. The records
//     arrive in the request body.
//   - Does not interpret fields - no trimming of item_number, no sign
//     flipping, no unit normalising, no rounding.
//   - Resets apply_status to 'pending' when re-ingesting an existing
//     (invoice_number, visual_order) pair, but leaves apply_reason
//     and matched_line_id for history (per spec §1).
//   - Rejects the whole record (not the batch) when invoice_number
//     or visual_order is missing; a missing identity would silently
//     collide on the upsert constraint.
//
// Idempotent: re-POSTing the same file lands the same rows. The
// `raw` column holds the whole original record so the apply pass can
// re-derive columns if a mapping ever turns out to have been wrong.

const MAX_RECORDS = 1000;

type RescanRecord = {
  invoice_number?: unknown;
  visual_order?: unknown;
  page?: unknown;
  vendor?: unknown;
  description_seen?: unknown;
  item_number?: unknown;
  pack_count?: unknown;
  pack_size_text?: unknown;
  pack_raw?: unknown;
  pack_confidence?: unknown;
  uom?: unknown;
  qty_ordered?: unknown;
  qty_shipped?: unknown;
  unit_price_seen?: unknown;
  extended_price_seen?: unknown;
  catch_weight?: unknown;
  notes?: unknown;
  [k: string]: unknown;
};

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export async function POST(req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  let body: { records?: unknown; batchLabel?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const records = Array.isArray(body.records) ? (body.records as RescanRecord[]) : null;
  if (!records) {
    return NextResponse.json({ error: "records must be an array" }, { status: 400 });
  }
  if (records.length > MAX_RECORDS) {
    return NextResponse.json(
      { error: `too many records; max ${MAX_RECORDS} per call` },
      { status: 400 }
    );
  }
  const batchLabel = asString(body.batchLabel);

  // Partition into valid vs rejected. Identity (invoice_number,
  // visual_order) is checked up front because the upsert constraint
  // would otherwise silently collide for a null visual_order or
  // concatenate two different lines under the same identity for a
  // missing invoice_number.
  const valid: Array<{ idx: number; row: RescanRecord & { invoice_number: string; visual_order: number } }> = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? {};
    const invoiceNumberRaw = asString(r.invoice_number);
    const invoiceNumber = invoiceNumberRaw ? invoiceNumberRaw.trim() : "";
    const visualOrder = asNumber(r.visual_order);
    if (!invoiceNumber) {
      rejected.push({ index: i, reason: "missing invoice_number" });
      continue;
    }
    if (visualOrder == null) {
      rejected.push({ index: i, reason: "missing visual_order" });
      continue;
    }
    valid.push({
      idx: i,
      row: { ...r, invoice_number: invoiceNumber, visual_order: visualOrder },
    });
  }

  if (valid.length === 0) {
    return NextResponse.json({
      received: records.length,
      inserted: 0,
      updated: 0,
      rejected,
      byInvoice: {},
    });
  }

  const client = serviceClient();

  // Identify pre-existing (invoice_number, visual_order) pairs so the
  // response can distinguish inserted vs updated accurately. PostgREST's
  // upsert does not surface which half fired per row.
  const existingKeys = new Set<string>();
  {
    const invoiceNumbers = Array.from(
      new Set(valid.map((v) => v.row.invoice_number))
    );
    for (let i = 0; i < invoiceNumbers.length; i += 200) {
      const slice = invoiceNumbers.slice(i, i + 200);
      const { data, error } = await client
        .from("pr_rescan_lines")
        .select("invoice_number,visual_order")
        .in("invoice_number", slice);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      for (const r of (data ?? []) as Array<{
        invoice_number: string;
        visual_order: number;
      }>) {
        existingKeys.add(`${r.invoice_number}::${r.visual_order}`);
      }
    }
  }

  // Build upsert payload. Mapped fields land in their columns; the
  // whole original record goes into `raw` (per 0010 header: "If a
  // column above is ever found to have been parsed wrongly, the
  // original is still here"). `apply_status` resets to 'pending' on
  // re-ingest, but apply_reason and matched_line_id are not written
  // here so previous apply history is preserved (spec §1).
  const payload = valid.map(({ row }) => ({
    invoice_number: row.invoice_number,
    visual_order: row.visual_order,
    page: asNumber(row.page),
    vendor: asString(row.vendor),
    description_seen: asString(row.description_seen),
    item_number: asString(row.item_number),
    pack_count: asNumber(row.pack_count),
    pack_size_text: asString(row.pack_size_text),
    pack_raw: asString(row.pack_raw),
    pack_confidence: asString(row.pack_confidence),
    uom: asString(row.uom),
    qty_ordered: asNumber(row.qty_ordered),
    qty_shipped: asNumber(row.qty_shipped),
    unit_price_seen: asNumber(row.unit_price_seen),
    extended_price_seen: asNumber(row.extended_price_seen),
    catch_weight: asBool(row.catch_weight),
    notes: asString(row.notes),
    raw: row,
    batch_label: batchLabel,
    apply_status: "pending",
  }));

  // Chunk upserts so very large payloads do not exceed Supabase limits.
  const byInvoice: Record<string, number> = {};
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const slice = payload.slice(i, i + 500);
    const { error } = await client
      .from("pr_rescan_lines")
      .upsert(slice, { onConflict: "invoice_number,visual_order" });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    for (const p of slice) {
      const key = `${p.invoice_number}::${p.visual_order}`;
      if (existingKeys.has(key)) updated += 1;
      else inserted += 1;
      byInvoice[p.invoice_number] = (byInvoice[p.invoice_number] ?? 0) + 1;
    }
  }

  return NextResponse.json({
    received: records.length,
    inserted,
    updated,
    rejected,
    byInvoice,
  });
}
