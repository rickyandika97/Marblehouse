import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { updateUser, updateUserSchema } from "@/server/services/users";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    const input = await parseJson(req, updateUserSchema);
    return updateUser(actor, id, input, { ipAddress: clientIp(req) });
  });
}
