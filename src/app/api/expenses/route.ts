import { handleRoute, parseJson } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  createExpense,
  createExpenseSchema,
  listExpenses,
  listExpensesSchema,
} from "@/server/services/expenses";

/**
 * Record an expense (§7.6).
 *
 * `businessDate` is computed server-side (§4.2) — the client never sends it.
 * The Idempotency-Key header makes a double-tap record one expense, not two
 * (NF-5); an expense is money, so the same rule that protects a sale applies.
 *
 * Note there is deliberately no `requireWorkSession` here, unlike a sale. An
 * expense names its own `shopId` — the owner records HQ costs without being
 * "at" HQ, and §8.8 lets them change the shop on the form.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, createExpenseSchema);

    return runIdempotent(actor, key, "POST /api/expenses", (tx) =>
      createExpense(actor, input, tx),
    );
  });
}

/** List expenses with a running total, scoped by role in SQL (§7.6, §8.8). */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { searchParams } = new URL(req.url);

    const input = listExpensesSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      categoryId: searchParams.get("categoryId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
    });

    return listExpenses(actor, input);
  });
}
