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

  const headers = [
    "name",
    "name_norm",
    "parent",
    "grade",
    "base_unit",
    "status",
    "merged_into_id",
    "yield_pct",
    "yield_source",
    "fdc_id",
    "fdc_name",
    "fdc_data_type",
    "allergens",
    "may_contain",
    "resale",
    "last_verified_at",
    "created_by",
    "created_at",
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
          .from("pr_ingredients")
          .select(
            "id,name,name_norm,parent,grade,base_unit,status,merged_into_id,yield_pct,yield_source,fdc_id,fdc_name,fdc_data_type,allergens,may_contain,resale,last_verified_at,created_by,created_at"
          )
          .order("name", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) {
          controller.error(error);
          return;
        }
        for (const r of (data ?? []) as Array<Record<string, unknown>>) {
          controller.enqueue(
            encoder.encode(
              csvRow([
                r.name,
                r.name_norm,
                r.parent,
                r.grade,
                r.base_unit,
                r.status,
                r.merged_into_id,
                r.yield_pct,
                r.yield_source,
                r.fdc_id,
                r.fdc_name,
                r.fdc_data_type,
                r.allergens,
                r.may_contain,
                r.resale,
                r.last_verified_at,
                r.created_by,
                r.created_at,
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
      "content-disposition": `attachment; filename="ingredients-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
