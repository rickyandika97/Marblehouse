/**
 * The audit reader must filter the complete immutable trail in SQL, then page
 * the matches. Searching a loaded 30-row page would make an older entry look
 * as if it did not exist.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, makeActorWithUser } from "./helpers";
import { listAuditLog } from "../audit-log";

const userIds: string[] = [];
const shopIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function ownerAndShop() {
  const shop = await prisma.shop.create({
    data: { code: `AL${Date.now()}`, name: "Audit Search PIK" },
  });
  shopIds.push(shop.id);
  const owner = await makeActorWithUser(prisma as unknown as Prisma.TransactionClient, {
    role: "OWNER",
  });
  userIds.push(owner.userId);
  return { owner, shop };
}

describe("listAuditLog", () => {
  it("searches the whole trail before taking its 30-entry page", async () => {
    const { owner, shop } = await ownerAndShop();
    const base = new Date("2026-08-20T08:00:00.000Z").getTime();

    await prisma.auditLog.createMany({
      data: Array.from({ length: 31 }, (_, index) => ({
        userId: owner.userId,
        role: "OWNER" as const,
        shopId: shop.id,
        entity: "Sale",
        entityId: `sale-${index}`,
        action: "VOID",
        reason: index === 30 ? "Needle in the older audit entry" : `ordinary row ${index}`,
        occurredAt: new Date(base - index * 60_000),
      })),
    });

    const all = await listAuditLog(owner);
    const result = await listAuditLog(owner, { q: "needle" });

    expect(all.rows).toHaveLength(30);
    expect(all.rows.some((row) => row.reason?.includes("Needle"))).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.reason).toBe("Needle in the older audit entry");
  });

  it("filters an inclusive Jakarta calendar-date range rather than UTC days", async () => {
    const { owner, shop } = await ownerAndShop();

    await prisma.auditLog.createMany({
      data: [
        {
          userId: owner.userId,
          role: "OWNER" as const,
          shopId: shop.id,
          entity: "Audit date test",
          action: "START_OF_DAY",
          occurredAt: new Date("2026-08-19T17:00:00.000Z"), // 20 Aug 00:00 Jakarta
        },
        {
          userId: owner.userId,
          role: "OWNER" as const,
          shopId: shop.id,
          entity: "Audit date test",
          action: "NEXT_DAY",
          occurredAt: new Date("2026-08-20T17:00:00.000Z"), // 21 Aug 00:00 Jakarta
        },
      ],
    });

    const result = await listAuditLog(owner, {
      from: "2026-08-20",
      to: "2026-08-20",
      entity: "Audit date test",
    });

    expect(result.rows.map((row) => row.action)).toContain("START_OF_DAY");
    expect(result.rows.map((row) => row.action)).not.toContain("NEXT_DAY");

    const twoDayRange = await listAuditLog(owner, {
      from: "2026-08-20",
      to: "2026-08-21",
      entity: "Audit date test",
    });
    expect(twoDayRange.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["START_OF_DAY", "NEXT_DAY"])
    );
  });

  it("searches stored before and after details as well as the summary fields", async () => {
    const { owner, shop } = await ownerAndShop();
    await prisma.auditLog.create({
      data: {
        userId: owner.userId,
        role: "OWNER",
        shopId: shop.id,
        entity: "Shop",
        action: "UPDATE",
        before: { name: "Old Needle Arcade" },
        after: { name: "New Arcade" },
      },
    });

    const result = await listAuditLog(owner, { q: "needle" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ entity: "Shop", action: "UPDATE" });
  });
});
