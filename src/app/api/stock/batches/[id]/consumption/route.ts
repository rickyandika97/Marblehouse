import { handleRoute } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import {
  listBatchConsumption,
  listBatchConsumptionSchema,
} from "@/server/services/stock";

/**
 * Where one lot's units went (D-156) — the consumption drill-down.
 *
 * Access is authorised against the BATCH'S shop inside the service, which has
 * to read the row first: the caller supplies only a batch id. Cost is gated on
 * shape, so a plain manager sees who took what and when and no money.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;

    return listBatchConsumption(actor, listBatchConsumptionSchema.parse({ batchId: id }));
  });
}
