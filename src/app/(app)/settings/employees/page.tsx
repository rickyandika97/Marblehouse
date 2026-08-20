import { requireOwnerPage } from "@/server/auth/page-guard";
import { prisma } from "@/lib/prisma";
import {
  listEmployees,
  listEmployeeSchedules,
} from "@/server/services/employees";
import {
  EmployeeAdmin,
  type EmployeeRow,
  type EmployeeSchedule,
} from "./employee-admin";

export const metadata = { title: "Employees · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Employees (§8.10, §7.9; renamed and rebuilt for per-shop roles
 * in D-122 — see that entry for why role moved off `User` onto `UserShop`).
 * OWNER only.
 *
 * This is the other half of the address-bar test: a MANAGER or STAFF session
 * typing /settings/employees is refused here, server-side, before the page
 * renders — and again by the API if they call it directly.
 */
export default async function EmployeesPage() {
  const actor = await requireOwnerPage();

  /**
   * EVERY shop, not `selectableShops`.
   *
   * `selectableShops` filters to active, non-HQ branches — right for the
   * day-start picker, wrong here. An existing employee may already be
   * assigned to a branch that has since been deactivated. If the edit form
   * cannot render those checkboxes, saving would submit a `shopRoles` array
   * with them missing and silently strip the assignment (D-109, extended by
   * D-122).
   *
   * Inactive shops are marked so the owner can see what they are, and are not
   * offered for a NEW assignment — `assertShopsExist` requires `isActive`, so
   * adding one would be a 422 anyway.
   */
  const [employees, schedules, shops] = await Promise.all([
    listEmployees(actor),
    listEmployeeSchedules(actor),
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
    <EmployeeAdmin
      initialEmployees={employees as EmployeeRow[]}
      schedules={schedules as EmployeeSchedule[]}
      shops={shops}
      currentUserId={actor.userId}
    />
  );
}
