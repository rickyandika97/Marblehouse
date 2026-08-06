import { handleRoute, parseJson } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import {
  listOpnames,
  startOpname,
  startOpnameSchema,
} from "@/server/services/opname";
import { AppError } from "@/server/errors";

/** Recent counting sessions at a shop (§7.4). */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const shopId = new URL(req.url).searchParams.get("shopId");
    if (!shopId) {
      throw new AppError("VALIDATION_FAILED", "Which branch's stock counts?", {
        fields: { shopId: "Required." },
      });
    }

    return listOpnames(actor, shopId);
  });
}

/**
 * Start a counting session (§4.11).
 *
 * The response deliberately carries NO system quantities — revealing them
 * before the count is entered would anchor the counter, which is the control
 * §4.11 exists to enforce.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const input = await parseJson(req, startOpnameSchema);

    return startOpname(actor, input);
  });
}
