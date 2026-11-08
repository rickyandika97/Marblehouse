/** Server CLI only. Business APIs never call this service. */
import { prisma } from "@/lib/prisma";
import { hashPassword, checkPasswordPolicy } from "@/server/auth/password";
import { technicianUserId, TECHNICIAN_ROLE } from "@/server/auth/technician";

export async function provisionTechnician(username: string, password: string) {
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error("Use a username of 3–32 lowercase letters, numbers, dots, dashes or underscores.");
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.message);
  const hash = await hashPassword(password);
  return prisma.$transaction(async tx => {
    const existing = await tx.user.findUnique({ where: { username }, include: { userShops: true } });
    if (existing && ((existing.id !== technicianUserId() && existing.role !== TECHNICIAN_ROLE) || existing.isOwner || existing.userShops.length)) {
      throw new Error("That username already belongs to another account. No changes made.");
    }
    const user = existing ?? await tx.user.create({ data: {
      username, displayUsername: username, name: "Technician", displayName: "Technician",
      email: `${username}@marblehouse.invalid`, role: TECHNICIAN_ROLE, isOwner: false,
      banned: false, mustChangePassword: false,
    } });
    await tx.user.update({ where: { id: user.id }, data: { role: TECHNICIAN_ROLE } });
    const credential = await tx.account.findFirst({ where: { userId: user.id, providerId: "credential" } });
    if (credential) await tx.account.update({ where: { id: credential.id }, data: { password: hash } });
    else await tx.account.create({ data: { providerId: "credential", accountId: user.id, userId: user.id, password: hash } });
    await tx.session.deleteMany({ where: { OR: [{ userId: user.id }, { impersonatedBy: user.id }] } });
    return { id: user.id, username };
  });
}
