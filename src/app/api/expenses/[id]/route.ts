import { z } from "zod";
import { handleRoute, parseJson } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import {
  deleteExpense,
  getExpense,
  updateExpense,
  updateExpenseSchema,
} from "@/server/services/expenses";

/** One expense, subject to the same shop scoping as the list (§7.6). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    return getExpense(actor, id);
  });
}

/** Edit an expense. OWNER only, audit-logged with before/after (§4.16). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const input = await parseJson(req, updateExpenseSchema);
    return updateExpense(actor, id, input);
  });
}

/**
 * The reason is mandatory, matching a sale void (§4.3) and a transfer cancel
 * (D-38). Deleting money without saying why is the case worth a paper trail.
 */
const deleteExpenseSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

/** Soft-delete an expense. OWNER only (§7.6, §6.1.5). */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const { reason } = await parseJson(req, deleteExpenseSchema);
    return deleteExpense(actor, id, reason);
  });
}
