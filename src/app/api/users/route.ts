import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { createUser, createUserSchema, listUsers } from "@/server/services/users";

export async function GET() {
  return handleRoute(async () => {
    const actor = await requireOwner();
    return { users: await listUsers(actor) };
  });
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const input = await parseJson(req, createUserSchema);
    return createUser(actor, input, { ipAddress: clientIp(req) });
  });
}
