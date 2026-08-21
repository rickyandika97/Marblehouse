import { requireOwner } from "@/server/auth/guards";
import { clientIp, handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  getCustomerWhatsAppReminderTemplate,
  updateCustomerWhatsAppReminderTemplate,
  updateCustomerWhatsAppReminderTemplateSchema,
} from "@/server/services/settings";

export async function GET() {
  return handleRoute(async () => {
    await requireOwner();
    return { template: await getCustomerWhatsAppReminderTemplate() };
  });
}

export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, updateCustomerWhatsAppReminderTemplateSchema);
    return runIdempotent(
      actor,
      key,
      "PATCH /api/settings/customer-whatsapp-reminder",
      (tx) =>
        updateCustomerWhatsAppReminderTemplate(actor, input.template, tx, {
          ipAddress: clientIp(req),
        })
    );
  });
}
