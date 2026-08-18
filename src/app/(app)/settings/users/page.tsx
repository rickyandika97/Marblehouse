import { requireOwnerPage } from "@/server/auth/page-guard";
import { prisma } from "@/lib/prisma";
import { listUsers } from "@/server/services/users";
import { UserAdmin, type UserRow } from "./user-admin";

export const metadata = { title: "Users · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Users (§8.10, §7.9). OWNER only.
 *
 * This is the other half of the address-bar test: a MANAGER or STAFF session
 * typing /settings/users is refused here, server-side, before the page
 * renders — and again by the API if they call it directly.
 */
export default async function UsersPage() {
  const actor = await requireOwnerPage();

  /**
   * EVERY shop, not `selectableShops`.
   *
   * `selectableShops` filters to active, non-HQ branches — right for the
   * day-start picker, wrong here. An existing user may already be assigned to
   * HQ (§4.12) or to a branch that has since been deactivated. If the edit form
   * cannot render those checkboxes, saving would submit a `shopIds` array with
   * them missing and silently strip the assignment (D-109).
   *
   * Inactive shops are marked so the owner can see what they are, and are not
   * offered for a NEW assignment — `assertShopsExist` requires `isActive`, so
   * adding one would be a 422 anyway.
   */
  const [users, shops] = await Promise.all([
    listUsers(actor),
    prisma.shop.findMany({
      orderBy: [{ isActive: "desc" }, { isHqPseudoShop: "asc" }, { name: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
        isHqPseudoShop: true,
      },
    }),
  ]);

  return (
    <UserAdmin
      initialUsers={users as UserRow[]}
      shops={shops}
      currentUserId={actor.userId}
    />
  );
}
