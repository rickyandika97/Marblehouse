import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { clockOut, clockOutSchema } from "@/server/services/attendance";

/** Clock out (§4.13). Lateness reporting is clock-in only in v1. */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const input = await parseJson(req, clockOutSchema);
    return clockOut(actor, input);
  });
}
