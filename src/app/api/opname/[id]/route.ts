import { handleRoute } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { getOpname } from "@/server/services/opname";

/**
 * One counting session with its lines (§7.4).
 *
 * `varianceValue` appears only for a caller who passes the cost gate — §4.11
 * gives the manager variance quantity only.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;

    return getOpname(actor, id);
  });
}
