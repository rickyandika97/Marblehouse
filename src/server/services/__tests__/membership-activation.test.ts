import { afterAll, describe, expect, test } from "vitest";
import {
  prisma,
  withRollback,
  makeActorWithUser,
  makeShop,
  uniq,
} from "./helpers";
import {
  activateMembership,
  activateMembershipSchema,
  assertCustomerAccess,
  hasCustomerAccess,
  hasCustomerProfileAccess,
  membershipStatus,
  replaceMembershipCard,
  scanMembership,
} from "../membership";
import { depositMarbles, withdrawMarbles, adjustMarbles } from "../marbles";
import { awardTickets, adjustTickets } from "../tickets";
import { mergeCustomers } from "../customers";
import { createRedemption } from "../redemptions";
import type { Actor } from "@/server/auth/context";
async function customer(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const suffix = uniq();
  return tx.customer.create({
    data: { name: "Legacy Kevin", phoneRaw: suffix, phoneNormalized: suffix },
  });
}
afterAll(() => prisma.$disconnect());

describe("one-time membership activation", () => {
  for (const role of ["STAFF", "MANAGER"] as const) {
    test(`${role} can view an unactivated profile/ledger/first card, but no balance action or redemption`, () =>
      withRollback(async (tx) => {
        const shop = await makeShop(tx);
        const base = await makeActorWithUser(tx, { role, shopIds: [shop.id] });
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
        expect(a.membershipActivatedAt).toBe(null);
        expect(await hasCustomerProfileAccess(actor, a.id, tx)).toBe(true);
        expect(await membershipStatus(actor, a.id, tx)).toEqual({
          activated: false,
          verified: false,
        });
        const denied = { code: "MEMBERSHIP_ACTIVATION_REQUIRED" };
        await expect(
          depositMarbles(actor, { customerId: a.id, qty: 5 }, tx),
        ).rejects.toMatchObject(denied);
        await expect(
          withdrawMarbles(actor, { customerId: a.id, qty: 1 }, tx),
        ).rejects.toMatchObject(denied);
        await expect(
          adjustMarbles(
            actor,
            { customerId: a.id, delta: 1, reason: "test" },
            tx,
          ),
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
        const before = {
          id: a.id,
          token: a.membershipToken,
          marbles: a.marbleBalance,
          tickets: a.ticketBalance,
        };
        await activateMembership(actor, a.id, tx);
        const activated = await tx.customer.findUniqueOrThrow({
          where: { id: a.id },
        });
        expect(activated.membershipActivatedAt).toBeInstanceOf(Date);
        expect({
          id: activated.id,
          token: activated.membershipToken,
          marbles: activated.marbleBalance,
          tickets: activated.ticketBalance,
        }).toEqual(before);
        expect(await hasCustomerProfileAccess(actor, a.id, tx)).toBe(false);
        expect(await hasCustomerAccess(actor, a.id, tx)).toBe(false);
        await expect(
          depositMarbles(actor, { customerId: a.id, qty: 5 }, tx),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
        await expect(activateMembership(actor, a.id, tx)).rejects.toMatchObject(
          { code: "CONFLICT" },
        );
        await scanMembership(
          actor,
          { code: `redlight:${a.membershipToken}`, customerId: a.id },
          tx,
        );
        expect(await membershipStatus(actor, a.id, tx)).toEqual({
          activated: true,
          verified: true,
        });
        expect(
          (await depositMarbles(actor, { customerId: a.id, qty: 5 }, tx))
            .customer.marbleBalance,
        ).toBe(5);
        expect(
          await tx.auditLog.count({
            where: { entityId: a.id, action: "ACTIVATE_MEMBERSHIP" },
          }),
        ).toBe(1);
      }));
  }
  test("activation clears old bootstrap grants for every session; only a fresh matching scan authorizes", () =>
    withRollback(async (tx) => {
      const actor = await makeActorWithUser(tx, { role: "STAFF" });
      const a = await customer(tx);
      await tx.customerVerification.create({
        data: {
          sessionId: actor.sessionId,
          userId: actor.userId,
          customerId: a.id,
          membershipToken: a.membershipToken,
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      expect(await hasCustomerAccess(actor, a.id, tx)).toBe(false);
      await activateMembership(actor, a.id, tx);
      expect(
        await tx.customerVerification.count({ where: { customerId: a.id } }),
      ).toBe(0);
      await expect(assertCustomerAccess(actor, a.id, tx)).rejects.toMatchObject(
        { code: "MEMBERSHIP_REQUIRED" },
      );
      await scanMembership(
        actor,
        { code: `redlight:${a.membershipToken}` },
        tx,
      );
      expect(await hasCustomerAccess(actor, a.id, tx)).toBe(true);
    }));
  test("a presented first QR activates once and grants access; a wrong customer's card cannot activate the selection", () =>
    withRollback(async (tx) => {
      const actor = await makeActorWithUser(tx, { role: "STAFF" });
      const a = await customer(tx),
        b = await customer(tx);
      await expect(
        scanMembership(
          actor,
          { code: `redlight:${b.membershipToken}`, customerId: a.id },
          tx,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        (await tx.customer.findUniqueOrThrow({ where: { id: b.id } }))
          .membershipActivatedAt,
      ).toBe(null);
      await scanMembership(
        actor,
        { code: `redlight:${a.membershipToken}` },
        tx,
      );
      await scanMembership(
        actor,
        { code: `redlight:${a.membershipToken}` },
        tx,
      );
      expect(
        await tx.auditLog.count({
          where: { entityId: a.id, action: "ACTIVATE_MEMBERSHIP" },
        }),
      ).toBe(1);
    }));
  test("inactive/merged customers cannot activate and owner replacement cannot reopen enrollment", () =>
    withRollback(async (tx) => {
      const owner = await makeActorWithUser(tx, { role: "OWNER" });
      const actor = await makeActorWithUser(tx, { role: "STAFF" });
      const a = await customer(tx);
      await tx.customer.update({
        where: { id: a.id },
        data: { isActive: false },
      });
      await expect(activateMembership(actor, a.id, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await tx.customer.update({
        where: { id: a.id },
        data: { isActive: true, mergedIntoId: "winner" },
      });
      await expect(activateMembership(actor, a.id, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await tx.customer.update({
        where: { id: a.id },
        data: { mergedIntoId: null },
      });
      await replaceMembershipCard(
        owner,
        a.id,
        { reason: "Owner issued a replacement" },
        tx,
      );
      expect(await hasCustomerProfileAccess(actor, a.id, tx)).toBe(false);
      expect(await hasCustomerAccess(owner, a.id, tx)).toBe(true);
    }));
  test("merging a protected account cannot reopen enrollment or retain an old grant", () =>
    withRollback(async (tx) => {
      const owner = await makeActorWithUser(tx, { role: "OWNER" });
      const staff = await makeActorWithUser(tx, { role: "STAFF" });
      const winner = await customer(tx),
        loser = await customer(tx);
      await activateMembership(owner, loser.id, tx);
      await tx.customerVerification.create({
        data: {
          sessionId: staff.sessionId,
          userId: staff.userId,
          customerId: winner.id,
          membershipToken: winner.membershipToken,
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      await mergeCustomers(
        owner,
        { winnerId: winner.id, loserId: loser.id },
        tx,
      );
      expect(
        (await tx.customer.findUniqueOrThrow({ where: { id: winner.id } }))
          .membershipActivatedAt,
      ).toBeInstanceOf(Date);
      expect(await hasCustomerProfileAccess(staff, winner.id, tx)).toBe(false);
      expect(
        await tx.customerVerification.count({
          where: { customerId: winner.id },
        }),
      ).toBe(0);
      await expect(
        scanMembership(
          staff,
          { code: `redlight:${loser.membershipToken}` },
          tx,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }));
  test("activation confirmation is explicit", () => {
    expect(activateMembershipSchema.safeParse({}).success).toBe(false);
    expect(
      activateMembershipSchema.safeParse({ cardSaved: false }).success,
    ).toBe(false);
    expect(
      activateMembershipSchema.safeParse({ cardSaved: true }).success,
    ).toBe(true);
  });
});
