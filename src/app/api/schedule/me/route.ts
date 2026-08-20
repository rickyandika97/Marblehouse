import { handleRoute } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { myScheduleToday } from "@/server/services/schedule";
import { AppError } from "@/server/errors";

/**
 * What the caller is rostered for today, at their work-session shop (§4.14.1).
 *
 * This is the endpoint the clock-in screen asks before deciding whether to
 * greet the user with their shift or offer the cover flow.
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    if (!actor.workSession) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Choose which branch you are working at first."
      );
    }
    return myScheduleToday(actor, actor.workSession.shopId);
  });
}
