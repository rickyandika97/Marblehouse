import { withRollback, uniq } from "./helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTechnician, isTechnician, isTechnicianAccount, businessUsersWhere } from "@/server/auth/technician";

afterEach(() => vi.unstubAllEnvs());
const support = { id: "support-id", role: "technician", banned: false, mustChangePassword: false };
describe("server-configured technician authority", () => {
  it("is disabled with no configured account", () => {
    vi.stubEnv("TECHNICIAN_USER_ID", "");
    expect(isTechnician(support)).toBe(false);
    expect(isTechnicianAccount(support)).toBe(true);
    expect(() => assertTechnician(support)).toThrow();
  });
  it("uses the immutable configured ID, rather than a username or business role", () => {
    vi.stubEnv("TECHNICIAN_USER_ID", support.id);
    expect(() => assertTechnician(support)).not.toThrow();
    expect(() => assertTechnician({ ...support, role: "user" })).toThrow();
    for (const role of ["OWNER", "MANAGER", "STAFF", "admin"]) {
      const businessUser = { ...support, id: `business-${role}`, username: "admin", role };
      expect(() => assertTechnician(businessUser)).toThrow();
    }
  });
  it("rejects deactivated and temporary-password support accounts", () => {
    vi.stubEnv("TECHNICIAN_USER_ID", support.id);
    expect(() => assertTechnician({ ...support, banned: true })).toThrow();
    expect(() => assertTechnician({ ...support, mustChangePassword: true })).toThrow();
    expect(() => assertTechnician(null)).toThrow();
  });
});


it("keeps disabled support accounts out of business lists without excluding legacy null roles", async () => {
  vi.stubEnv("TECHNICIAN_USER_ID", "");
  await withRollback(async tx => {
    const suffix = uniq();
    const hidden = await tx.user.create({ data: { email: `support-${suffix}@marblehouse.invalid`, name: "Support", displayName: "Support", role: "technician" } });
    const ordinary = await tx.user.create({ data: { email: `business-${suffix}@marblehouse.invalid`, name: "Business", displayName: "Business", role: null } });
    const rows = await tx.user.findMany({ where: { AND: [{ id: { in: [hidden.id, ordinary.id] } }, businessUsersWhere()] }, select: { id: true } });
    expect(rows.map(row => row.id)).toEqual([ordinary.id]);
  });
});
