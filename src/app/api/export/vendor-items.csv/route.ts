import { NextRequest } from "next/server";
import { requireOwnerApi } from "@/lib/gate";
import { serviceClient } from "@/lib/supabase/service";
import { csvRow } from "@/lib/csv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: NextRequest) {
  const gate = await requireOwnerApi();
  if (gate instanceof Response) return gate;

  const client = serviceClient();
  const { data: vendors } = await client.from("pr_vendors").select("id,name");
  const vendorNameById = new Map((vendors ?? []).map((v: { id: string; name: string }) => [v.id, v.name]));

  const headers = [
    "vendor",
    "vendor_id",
    "item_number",
    "item_number_norm",
    "description_key",
    "name",
    "status",
    "link_status",
    "is_food",
    "food_reason",
    "pack_text",
    "pack_state",
    "billed_unit",
    "catch_weight",
    "usd_12m",
    "usd_lifetime",
    "lines_12m",
    "lines_lifetime",
    "accounts",
    "needs_review_lines",
    "duplicate_of_id",
    "first_seen",
    "last_seen",
    "id",
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(csvRow(headers)));

      const pageSize = 1000;
      let from = 0;
      for (;;) {
        const { data, error } = await client
          .from("pr_vendor_items")
          .select(
            "id,vendor_id,item_number,item_number_norm,description_key,name,status,link_status,is_food,food_reason,pack_text,pack_state,billed_unit,catch_weight,usd_12m,usd,lines_12m,lines,accounts,needs_review_lines,duplicate_of_id,first_seen,last_seen"
          )
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) {
          controller.error(error);
          return;
        }
        for (const r of (data ?? []) as Array<Record<string, unknown>>) {
          controller.enqueue(
            encoder.encode(
              csvRow([
                vendorNameById.get(r.vendor_id as string) ?? r.vendor_id,
                r.vendor_id,
                r.item_number,
                r.item_number_norm,
                r.description_key,
                r.name,
                r.status,
                r.link_status,
                r.is_food,
                r.food_reason,
                r.pack_text,
                r.pack_state,
                r.billed_unit,
                r.catch_weight,
                r.usd_12m,
                r.usd,
                r.lines_12m,
                r.lines,
                r.accounts,
                r.needs_review_lines,
                r.duplicate_of_id,
                r.first_seen,
                r.last_seen,
                r.id,
              ])
            )
          );
        }
        if ((data ?? []).length < pageSize) break;
        from += pageSize;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="vendor-items-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
