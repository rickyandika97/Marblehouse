import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { createEmployee, createEmployeeSchema, listEmployees } from "@/server/services/employees";

export async function GET() {
  return handleRoute(async () => {
    const actor = await requireOwner();
    return { employees: await listEmployees(actor) };
  });
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const input = await parseJson(req, createEmployeeSchema);
    return createEmployee(actor, input, { ipAddress: clientIp(req) });
  });
}
