import { requireOwnerPage } from "@/server/auth/page-guard";
import { listShops } from "@/server/services/shops";
import { ShopAdmin } from "./shop-admin";

export const metadata = { title: "Shops · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Shops (§5.6, §8.10). OWNER only.
 *
 * Not to be confused with Settings → **Shop** (singular), which is the
 * day-start work-session picker every role gets. This is branch administration
 * and a MANAGER or STAFF session is refused here server-side, before render —
 * and again by the API if they call it directly.
 */
export default async function ShopsPage() {
  const actor = await requireOwnerPage();
  const shops = await listShops(actor);

  return <ShopAdmin initialShops={shops} />;
}
