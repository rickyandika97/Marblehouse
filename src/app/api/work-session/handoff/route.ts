import { requireSettledActor } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import { scheduledShopHandoff } from "@/server/services/work-session";

/** Current user's upcoming/active rostered branch handoff. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    return { handoff: await scheduledShopHandoff(actor) };
  });
}
