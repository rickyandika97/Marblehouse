import { requireOwnerPage } from "@/server/auth/page-guard";
import { selectableShops } from "@/server/auth/context";
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

  const [users, shops] = await Promise.all([
    listUsers(actor),
    selectableShops(actor),
  ]);

  return (
    <UserAdmin
      initialUsers={users as UserRow[]}
      shops={shops.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
    />
  );
}
