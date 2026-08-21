import { requireActorPage } from "@/server/auth/page-guard";
import { searchCustomers } from "@/server/services/customers";
import { getCustomerWhatsAppReminderTemplate } from "@/server/services/settings";
import { CustomerSearch } from "./customer-search";

export const metadata = { title: "Customers · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Customer lookup (§8.5). Every role may look a customer up (§3.4).
 *
 * Success criterion 1.4.2: "a customer can walk into any branch, give their
 * phone number, and have their exact marble and ticket balance appear in under
 * three seconds." That is why this screen is search-first and nothing else.
 */
export default async function CustomersPage() {
  const actor = await requireActorPage();

  // Seed the list server-side so the screen is useful before the first
  // keystroke — most lookups are a recent customer.
  const [{ customers }, whatsappReminderTemplate] = await Promise.all([
    searchCustomers(actor, {}),
    getCustomerWhatsAppReminderTemplate(),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search by phone number or name.
        </p>
      </div>

      <CustomerSearch
        initial={customers}
        whatsappReminderTemplate={whatsappReminderTemplate}
      />
    </div>
  );
}
