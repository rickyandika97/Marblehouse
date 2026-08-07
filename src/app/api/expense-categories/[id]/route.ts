import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  deleteCategory,
  updateCategory,
  updateCategorySchema,
} from "@/server/services/expenses";

/** Rename, reorder or archive a category. OWNER only (§7.6). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const input = await parseJson(req, updateCategorySchema);
    return updateCategory(actor, id, input);
  });
}

/**
 * Delete a category — Phase 7's acceptance criterion (§16).
 *
 * Zero expense rows deletes outright. Otherwise the service throws
 * `CATEGORY_IN_USE`, which `handleRoute` renders as a **409 carrying the usage
 * count** in `error.details.usageCount`. Never a silent archive.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    return deleteCategory(actor, id);
  });
}
