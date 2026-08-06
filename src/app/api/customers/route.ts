import { handleRoute, parseJson } from "@/server/http";
import { requireSettledActor, assertShopAccess } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  createCustomer,
  createCustomerSchema,
  searchCustomers,
  searchCustomersSchema,
} from "@/server/services/customers";

/** Search by partial phone digits or name (§7.3). Every role may look up. */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { searchParams } = new URL(req.url);

    const input = searchCustomersSchema.parse({
      q: searchParams.get("q") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      shopId: searchParams.get("shopId") ?? undefined,
    });

    // A shop filter must not become a way to read a branch you have no access
    // to — check it here rather than trusting the query string.
    if (input.shopId) assertShopAccess(actor, input.shopId);

    return searchCustomers(actor, input);
  });
}

/**
 * Create a customer (§7.3).
 *
 * Idempotent: the "+ New customer" form sits inside the sale flow, where a
 * double-tap is just as likely as on the sale button itself.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, createCustomerSchema);

    return runIdempotent(actor, key, "POST /api/customers", () =>
      createCustomer(actor, input)
    );
  });
}
