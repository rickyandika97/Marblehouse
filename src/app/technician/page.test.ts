import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getAuthSession: mocks.session }));
vi.mock("@/server/services/technician", () => ({ listTechnicianUsers: mocks.list }));
vi.mock("@/components/technician-controls", () => ({ TechnicianPanel: () => null }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
  forbidden: () => { throw new Error("forbidden"); },
}));
import TechnicianPage from "./page";

beforeEach(() => vi.clearAllMocks());

it.each(["OWNER", "MANAGER", "STAFF"])("routes a borrowed %s away from the technician page", async role => {
  mocks.session.mockResolvedValue({ user: { id: "business", role: "user", isOwner: role === "OWNER" }, session: { impersonatedBy: "support" } });
  await expect(TechnicianPage()).rejects.toThrow("redirect:/");
  expect(mocks.list).not.toHaveBeenCalled();
});

it("still refuses an ordinary business session", async () => {
  mocks.session.mockResolvedValue({ user: { id: "business", role: "user" }, session: {} });
  await expect(TechnicianPage()).rejects.toThrow("forbidden");
  expect(mocks.list).not.toHaveBeenCalled();
});

it("sends an expired session to login", async () => {
  mocks.session.mockResolvedValue(null);
  await expect(TechnicianPage()).rejects.toThrow("redirect:/login");
});
