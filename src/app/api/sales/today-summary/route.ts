import { handleRoute } from "@/server/http";
import { requireWorkSession } from "@/server/auth/guards";
import { todaySummary } from "@/server/services/sales";

/** Today's count, total and payment split for the current shop (§7.2, §8.2). */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    return todaySummary(actor);
  });
}
