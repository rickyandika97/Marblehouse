import { requireOwner } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import {
  listTicketAwardReport,
  ticketAwardReportSchema,
} from "@/server/services/ticket-reports";

export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { searchParams } = new URL(req.url);
    const input = ticketAwardReportSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
    });
    return listTicketAwardReport(actor, input);
  });
}

