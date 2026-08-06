import { handleRoute, parseJson } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import {
  getCustomerForActor,
  updateCustomer,
  updateCustomerSchema,
} from "@/server/services/customers";

/**
 * Customer detail (§7.3).
 *
 * Role shaping happens in the service, which calls a different DTO builder for
 * OWNER — spend and visit history are owner-only (§3.4, requirement 9.1).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    return getCustomerForActor(actor, id);
  });
}

/** Edit name, phone or note (§7.3). Any role may correct a customer record. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const input = await parseJson(req, updateCustomerSchema);
    return updateCustomer(actor, id, input);
  });
}
