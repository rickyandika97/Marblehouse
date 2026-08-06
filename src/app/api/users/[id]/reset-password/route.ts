import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { resetPasswordSchema, resetUserPassword } from "@/server/services/users";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    const { newPassword } = await parseJson(req, resetPasswordSchema);
    await resetUserPassword(actor, id, newPassword, { ipAddress: clientIp(req) });
    return { ok: true };
  });
}
