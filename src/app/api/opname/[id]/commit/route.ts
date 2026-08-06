import { handleRoute } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { commitOpname } from "@/server/services/opname";

/**
 * Apply the variances (§4.11, §7.4).
 *
 * Negative variance consumes FIFO as OPNAME_LOSS; positive creates an
 * adjustment batch at weighted-average cost. The service refuses a second
 * commit, so a double-tap cannot apply the same shrinkage twice.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;

    return commitOpname(actor, id, actor.businessDate);
  });
}
