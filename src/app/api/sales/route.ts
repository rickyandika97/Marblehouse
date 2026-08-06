import { handleRoute, parseJson } from "@/server/http";
import { requireSettledActor, requireWorkSession } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  createSale,
  createSaleSchema,
  listSales,
  listSalesSchema,
} from "@/server/services/sales";

/**
 * Record a sale (§7.2).
 *
 * Shop and user come from the work session and the session cookie — the client
 * cannot set them. The Idempotency-Key header is what makes a double-tap on
 * slow shop wifi produce exactly one sale (NF-5, R-3).
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, createSaleSchema);

    return runIdempotent(actor, key, "POST /api/sales", (tx) =>
      createSale(actor, input, tx)
    );
  });
}

/** List sales, scoped by role in the service (§7.2). */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { searchParams } = new URL(req.url);

    const input = listSalesSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      userId: searchParams.get("userId") ?? undefined,
      customerId: searchParams.get("customerId") ?? undefined,
      paymentMethod: searchParams.get("paymentMethod") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
    });

    return listSales(actor, input);
  });
}
