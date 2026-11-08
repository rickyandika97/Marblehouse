import { afterAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import {
  prisma,
  withRollback,
  makeActorWithUser,
  makeShop,
  uniq,
} from "./helpers";
import {
  scanMembership,
  assertCustomerAccess,
  hasCustomerAccess,
  replaceMembershipCard,
} from "../membership";
import { depositMarbles, withdrawMarbles } from "../marbles";
import { awardTickets, adjustTickets } from "../tickets";
import { createRedemption } from "../redemptions";
import type { Actor } from "@/server/auth/context";

async function customer(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const suffix = uniq();
  return tx.customer.create({
    data: {
      name: "Kevin",
      phoneRaw: suffix,
      phoneNormalized: suffix,
      membershipActivatedAt: new Date(),
    },
  });
}
afterAll(() => prisma.$disconnect());

describe("membership authentication", () => {
  for (const role of ["STAFF", "MANAGER"] as const) {
    test(`${role} cannot bypass scanning; matching QR grants only that account`, () =>
      withRollback(async (tx) => {
        const actor = await makeActorWithUser(tx, { role });
        const a = await customer(tx),
          b = await customer(tx);
        expect(a.membershipToken).not.toBe(b.membershipToken);
        await expect(
          assertCustomerAccess(actor, a.id, tx),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
        await expect(
          scanMembership(
            actor,
            { code: `redlight:${b.membershipToken}`, customerId: a.id },
            tx,
          ),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await scanMembership(
          actor,
          { code: `redlight:${a.membershipToken}`, customerId: a.id },
          tx,
        );
        await expect(
          assertCustomerAccess(actor, a.id, tx),
        ).resolves.toBeUndefined();
        expect(await hasCustomerAccess(actor, b.id, tx)).toBe(false);
        expect(
          await hasCustomerAccess(
            { ...actor, sessionId: randomUUID() },
            a.id,
            tx,
          ),
        ).toBe(false);
        expect(
          await hasCustomerAccess({ ...actor, userId: randomUUID() }, a.id, tx),
        ).toBe(false);
        await expect(
          replaceMembershipCard(actor, a.id, { reason: "Lost card" }, tx),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await scanMembership(
          actor,
          { code: `redlight:${b.membershipToken}` },
          tx,
        );
        expect(await hasCustomerAccess(actor, a.id, tx)).toBe(false);
        await tx.customerVerification.update({
          where: { sessionId: actor.sessionId },
          data: { expiresAt: new Date(0) },
        });
        expect(await hasCustomerAccess(actor, b.id, tx)).toBe(false);
      }));
  }
  test("only owner bypasses; replacement invalidates old card and all grants", () =>
    withRollback(async (tx) => {
      const owner = await makeActorWithUser(tx, { role: "OWNER" });
      const actor = await makeActorWithUser(tx, { role: "STAFF" });
      const a = await customer(tx);
      expect(await hasCustomerAccess(owner, a.id, tx)).toBe(true);
      await scanMembership(
        actor,
        { code: `redlight:${a.membershipToken}` },
        tx,
      );
      await replaceMembershipCard(
        owner,
        a.id,
        { reason: "Independently verified lost card" },
        tx,
      );
      expect(await hasCustomerAccess(actor, a.id, tx)).toBe(false);
      await expect(
        scanMembership(actor, { code: `redlight:${a.membershipToken}` }, tx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const changed = await tx.customer.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(changed.membershipToken).not.toBe(a.membershipToken);
      await scanMembership(
        actor,
        { code: `redlight:${changed.membershipToken}` },
        tx,
      );
      expect(await hasCustomerAccess(actor, a.id, tx)).toBe(true);
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { entityId: a.id, action: "REPLACE_MEMBERSHIP" },
      });
      expect(JSON.stringify(audit)).not.toContain(changed.membershipToken);
    }));
  test("inactive and merged cards cannot authenticate", () =>
    withRollback(async (tx) => {
      const actor = await makeActorWithUser(tx, { role: "STAFF" });
      const a = await customer(tx);
      await scanMembership(
        actor,
        { code: `redlight:${a.membershipToken}` },
        tx,
      );
      await tx.customer.update({
        where: { id: a.id },
        data: { isActive: false },
      });
      expect(await hasCustomerAccess(actor, a.id, tx)).toBe(false);
      await expect(
        scanMembership(actor, { code: `redlight:${a.membershipToken}` }, tx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await tx.customer.update({
        where: { id: a.id },
        data: { isActive: true, mergedIntoId: "winner" },
      });
      await expect(
        scanMembership(actor, { code: `redlight:${a.membershipToken}` }, tx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }));
  test("direct balance and redemption calls cannot skip verification; scan enables deposit", () =>
    withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const base = await makeActorWithUser(tx, {
        role: "MANAGER",
        shopIds: [shop.id],
      });
      const actor = {
        ...base,
        workSession: {
          id: "test",
          userId: base.userId,
          shopId: shop.id,
          shop,
          businessDate: base.businessDate,
        },
      } as Actor & { workSession: NonNullable<Actor["workSession"]> };
      const a = await customer(tx);
      const denied = { code: "MEMBERSHIP_REQUIRED" };
      await expect(
        depositMarbles(actor, { customerId: a.id, qty: 10 }, tx),
      ).rejects.toMatchObject(denied);
      await expect(
        withdrawMarbles(actor, { customerId: a.id, qty: 1 }, tx),
      ).rejects.toMatchObject(denied);
      await expect(
        awardTickets(
          actor,
          { customerId: a.id, qty: 1, ticketsCollected: true },
          tx,
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        adjustTickets(
          actor,
          { customerId: a.id, delta: 1, reason: "test" },
          tx,
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        createRedemption(
          actor,
          { customerId: a.id, lines: [{ prizeItemId: "fake", qty: 1 }] },
          tx,
        ),
      ).rejects.toMatchObject(denied);
      expect(await tx.marbleLedger.count({ where: { customerId: a.id } })).toBe(
        0,
      );
      await scanMembership(
        actor,
        { code: `redlight:${a.membershipToken}` },
        tx,
      );
      expect(
        await hasCustomerAccess(
          { ...actor, workSession: { ...actor.workSession, shopId: "other" } },
          a.id,
          tx,
        ),
      ).toBe(false);
      const result = await depositMarbles(
        actor,
        { customerId: a.id, qty: 10 },
        tx,
      );
      expect(result.customer.marbleBalance).toBe(10);
    }));
});
