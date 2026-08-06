import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import {
  changeWorkSession,
  changeWorkSessionSchema,
  setWorkSession,
  setWorkSessionSchema,
} from "@/server/services/work-session";

/** Create today's work session — the day-start shop picker (§4.7). */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const input = await parseJson(req, setWorkSessionSchema);
    const session = await setWorkSession(actor, input);
    return { shopId: session.shopId, shopName: session.shop.name };
  });
}

/** Change today's shop from Settings — audit-logged, reason may be required. */
export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const input = await parseJson(req, changeWorkSessionSchema);
    const session = await changeWorkSession(actor, input, {
      ipAddress: clientIp(req),
    });
    return {
      shopId: session.shopId,
      shopName: session.shop.name,
      changedCount: session.changedCount,
    };
  });
}
