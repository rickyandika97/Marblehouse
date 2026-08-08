import { handleRoute } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { listAuditLog, listAuditLogSchema } from "@/server/services/audit-log";

/** §4.16's trail, read-only and owner-only. There is no POST/PATCH/DELETE. */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const params = new URL(req.url).searchParams;

    const input = listAuditLogSchema.parse({
      entity: params.get("entity") || undefined,
      action: params.get("action") || undefined,
      userId: params.get("userId") || undefined,
      cursor: params.get("cursor") || undefined,
      limit: params.get("limit") ? Number(params.get("limit")) : undefined,
    });

    return listAuditLog(actor, input);
  });
}
