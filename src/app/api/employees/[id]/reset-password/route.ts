import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { resetPasswordSchema, resetEmployeePassword } from "@/server/services/employees";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    const { newPassword } = await parseJson(req, resetPasswordSchema);
    await resetEmployeePassword(actor, id, newPassword, { ipAddress: clientIp(req) });
    return { ok: true };
  });
}
