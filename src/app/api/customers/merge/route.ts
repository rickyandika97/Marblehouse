import { requireOwner } from "@/server/auth/guards";
import { clientIp, handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  mergeCustomers,
  mergeCustomersSchema,
} from "@/server/services/customers";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, mergeCustomersSchema);
    return runIdempotent(actor, key, "POST /api/customers/merge", (tx) =>
      mergeCustomers(actor, input, tx, { ipAddress: clientIp(req) })
    );
  });
}

