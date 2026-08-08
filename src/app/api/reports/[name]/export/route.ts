/**
 * §7.8 GET /api/reports/:name/export — CSV.
 *
 * Returns a `Response` directly; `handleRoute` passes it through untouched
 * (D-50), so this route keeps the same auth guard and the same AppError
 * envelope as every JSON endpoint instead of hand-rolling a try/catch.
 *
 * Cost columns are decided inside `buildExport`, at the query level (§7.8) —
 * never by filtering headers off a costed row set.
 */
import { requireManagerOrOwner } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import { csvResponse } from "@/server/csv";
import { buildExport } from "@/server/services/reports-export";
import { reportRangeSchema } from "@/server/services/reports";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { name } = await params;
    const { searchParams } = new URL(req.url);
    const input = reportRangeSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
    });

    const { filename, csv } = await buildExport(name, actor, input);
    return csvResponse(filename, csv);
  });
}
