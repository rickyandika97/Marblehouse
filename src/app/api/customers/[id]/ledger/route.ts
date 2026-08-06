import { requireSettledActor } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import {
  listCustomerLedger,
  listLedgerSchema,
} from "@/server/services/balances";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const input = listLedgerSchema.parse({
      cursor: searchParams.get("cursor") ?? undefined,
    });
    return listCustomerLedger(actor, id, input.cursor);
  });
}

