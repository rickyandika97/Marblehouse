import { requireOwnerPage } from "@/server/auth/page-guard";
import { getTicketAwardReasonThreshold } from "@/server/services/settings";
import { TicketAwardThresholdForm } from "./ticket-award-threshold-form";

export const metadata = { title: "System settings · Marblehouse" };
export const dynamic = "force-dynamic";

export default async function SystemSettingsPage() {
  await requireOwnerPage();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">System settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Business-wide controls. Changes are audit-logged.
        </p>
      </div>
      <TicketAwardThresholdForm initial={await getTicketAwardReasonThreshold()} />
    </div>
  );
}

