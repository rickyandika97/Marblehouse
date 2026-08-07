import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  categorySchema,
  createCategory,
  listCategories,
} from "@/server/services/expenses";

/**
 * Expense categories (§7.6).
 *
 * `?includeArchived=true` is for the owner's category manager, which must show
 * an archived row in order to offer un-archiving it. The default list is
 * non-archived, which is what an expense form should offer (§4.12).
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const includeArchived =
      new URL(req.url).searchParams.get("includeArchived") === "true";
    return listCategories(actor, { includeArchived });
  });
}

/** Create a category. OWNER only. */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const input = await parseJson(req, categorySchema);
    return createCategory(actor, input);
  });
}
