import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { updateEmployee, updateEmployeeSchema } from "@/server/services/employees";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    const input = await parseJson(req, updateEmployeeSchema);
    return updateEmployee(actor, id, input, { ipAddress: clientIp(req) });
  });
}
