/** Support authority is configured on the server, never through business roles. */
import type { User } from "@prisma/client";
import { forbidden } from "@/server/errors";

export const TECHNICIAN_ROLE = "technician";
export function technicianUserId(): string | undefined {
  return process.env.TECHNICIAN_USER_ID?.trim() || undefined;
}
/** Persistent marker also keeps disabled technician accounts hidden/protected. */
export function isTechnicianAccount(user: { id: string; role?: string | null }): boolean {
  return user.role === TECHNICIAN_ROLE || Boolean(technicianUserId() && user.id === technicianUserId());
}
export function isTechnician(user: { id: string; role?: string | null }): boolean {
  return user.role === TECHNICIAN_ROLE && Boolean(technicianUserId() && user.id === technicianUserId());
}
export const businessUsersWhere = () => ({
  id: { not: technicianUserId() },
  OR: [{ role: null }, { role: { not: TECHNICIAN_ROLE } }],
});
export function assertTechnician(user: Pick<User, "id" | "role" | "banned" | "mustChangePassword"> | null): void {
  if (!user || !isTechnician(user) || user.banned || user.mustChangePassword) {
    throw forbidden("Technician access required.");
  }
}
