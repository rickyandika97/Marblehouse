import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { z } from "zod";
import { listShopStaff, setShopAssignment } from "@/server/services/users";

/**
 * Who works at this shop (§5.6, §7.9). OWNER only.
 *
 * The same `UserShop` rows `/api/users/:id` manages, reached from the shop.
 * Both are owner-gated — this is user administration however you arrive.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    return listShopStaff(actor, id);
  });
}

const assignSchema = z.object({
  userId: z.string().min(1),
  assigned: z.boolean(),
});

/**
 * Assign or unassign ONE person here.
 *
 * Deliberately a single (user, shop) pair rather than a whole-array replace —
 * a stale checkbox must not be able to revoke a branch nobody was looking at.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    const input = await parseJson(req, assignSchema);
    return setShopAssignment(actor, id, input.userId, input.assigned, {
      ipAddress: clientIp(req),
    });
  });
}
