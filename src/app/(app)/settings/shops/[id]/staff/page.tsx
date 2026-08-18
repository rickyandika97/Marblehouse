import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireOwnerPage, asPageError } from "@/server/auth/page-guard";
import { getShop } from "@/server/services/shops";
import { listShopStaff } from "@/server/services/users";
import { StaffAdmin } from "./staff-admin";

export const metadata = { title: "Staff · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Shops → *this shop* → Staff (§5.6, §7.9). OWNER only.
 *
 * The last of D-101's three follow-up steps. Assigning shop access is owner
 * work (§3.4 "Create user, set role, set shop access" — owner column only), so
 * unlike the shifts screen this one is NOT delegated to managers.
 *
 * This does not create accounts; Settings → Users still owns that. It answers
 * the question you actually have when opening a branch — "who works here?" —
 * without editing every person in turn.
 */
export default async function ShopStaffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireOwnerPage();
  const { id } = await params;

  try {
    const [shop, staff] = await Promise.all([
      getShop(actor, id),
      listShopStaff(actor, id),
    ]);

    return (
      <div className="space-y-6">
        <div>
          <Link
            href="/settings/shops"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Shops
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Staff</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {shop.name} · {shop.code}. Who can pick this branch when they start
            their day.
          </p>
        </div>

        <StaffAdmin
          shopId={shop.id}
          shopName={shop.name}
          initialAssigned={staff.assigned}
          initialAvailable={staff.available}
        />
      </div>
    );
  } catch (e) {
    asPageError(e);
  }
}
