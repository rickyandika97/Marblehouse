import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Customer, Prisma } from "@prisma/client";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { memberNumber } from "@/lib/member-number";
import type { Actor } from "@/server/auth/context";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";

export const scanMembershipSchema = z.object({
  code: z.string().regex(/^redlight:[a-f0-9-]{36}$/i),
  customerId: z.string().min(1).optional(),
});
export const replaceMembershipSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export const activateMembershipSchema = z.object({
  cardSaved: z.literal(true),
});
export const VERIFICATION_MS = 5 * 60 * 1000;

export async function grantCustomerAccess(
  actor: Actor,
  customerId: string,
  membershipToken: string,
  tx: Prisma.TransactionClient,
) {
  const data = {
    userId: actor.userId,
    shopId: actor.workSession?.shopId ?? null,
    customerId,
    membershipToken,
    expiresAt: new Date(Date.now() + VERIFICATION_MS),
  };
  await tx.customerVerification.upsert({
    where: { sessionId: actor.sessionId },
    create: { sessionId: actor.sessionId, ...data },
    update: data,
  });
}

export async function hasCustomerAccess(
  actor: Actor,
  customerId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  if (actor.isOwner) return true;
  const grant = await tx.customerVerification.findUnique({
    where: { sessionId: actor.sessionId },
    include: { customer: true },
  });
  return (
    !!grant &&
    grant.userId === actor.userId &&
    grant.shopId === (actor.workSession?.shopId ?? null) &&
    grant.customerId === customerId &&
    grant.expiresAt.getTime() > Date.now() &&
    grant.customer.membershipActivatedAt !== null &&
    grant.customer.isActive &&
    !grant.customer.mergedIntoId &&
    grant.membershipToken === grant.customer.membershipToken
  );
}

/** Unactivated profiles can be read and their first card issued, but never transact. */
export async function hasCustomerProfileAccess(
  actor: Actor,
  id: string,
  tx: Prisma.TransactionClient = prisma,
) {
  if (actor.isOwner) return true;
  const customer = await tx.customer.findUnique({
    where: { id },
    select: { isActive: true, mergedIntoId: true, membershipActivatedAt: true },
  });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound();
  return (
    customer.membershipActivatedAt === null || hasCustomerAccess(actor, id, tx)
  );
}

export async function assertCustomerProfileAccess(
  actor: Actor,
  id: string,
  tx: Prisma.TransactionClient = prisma,
) {
  if (tx !== prisma)
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE`;
  if (!(await hasCustomerProfileAccess(actor, id, tx)))
    throw new AppError(
      "MEMBERSHIP_REQUIRED",
      "Scan this customer's membership QR to continue. Only the owner can bypass scanning.",
    );
}

export async function membershipStatus(
  actor: Actor,
  id: string,
  tx: Prisma.TransactionClient = prisma,
) {
  const customer = await tx.customer.findUnique({
    where: { id },
    select: { isActive: true, mergedIntoId: true, membershipActivatedAt: true },
  });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound();
  return {
    activated: customer.membershipActivatedAt !== null,
    verified: await hasCustomerAccess(actor, id, tx),
  };
}

async function activateRecord(
  actor: Actor,
  id: string,
  tx: Prisma.TransactionClient,
  reason: string,
) {
  const activatedAt = new Date();
  await tx.customer.update({
    where: { id },
    data: { membershipActivatedAt: activatedAt },
  });
  // First-card issuance must never leave an old bootstrap/scan grant usable.
  await tx.customerVerification.deleteMany({ where: { customerId: id } });
  await writeAudit(
    actor,
    {
      entity: "Customer",
      entityId: id,
      action: "ACTIVATE_MEMBERSHIP",
      after: { activatedAt: activatedAt.toISOString() },
      reason,
    },
    tx,
  );
  return { activated: true, activatedAt: activatedAt.toISOString() };
}

export async function activateMembership(
  actor: Actor,
  id: string,
  tx: Prisma.TransactionClient,
) {
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE`;
  const customer = await tx.customer.findUnique({ where: { id } });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound();
  if (customer.membershipActivatedAt !== null)
    throw new AppError(
      "CONFLICT",
      "This membership is already activated. Scan the customer's card; only the owner can replace a lost card.",
    );
  return activateRecord(
    actor,
    id,
    tx,
    "Staff confirmed the customer has saved their first membership card.",
  );
}

export async function assertCustomerAccess(
  actor: Actor,
  customerId: string,
  tx: Prisma.TransactionClient = prisma,
) {
  if (tx !== prisma)
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`;
  if (!actor.isOwner) {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: {
        membershipActivatedAt: true,
        isActive: true,
        mergedIntoId: true,
      },
    });
    if (!customer || !customer.isActive || customer.mergedIntoId)
      throw notFound();
    if (customer.membershipActivatedAt === null)
      throw new AppError(
        "MEMBERSHIP_ACTIVATION_REQUIRED",
        "Give the customer their membership card and activate it, then scan their QR before changing balances or redeeming prizes.",
      );
  }
  if (!(await hasCustomerAccess(actor, customerId, tx)))
    throw new AppError(
      "MEMBERSHIP_REQUIRED",
      "Scan this customer's membership QR to continue. Only the owner can bypass scanning.",
    );
}

export async function scanMembership(
  actor: Actor,
  input: z.infer<typeof scanMembershipSchema>,
  tx: Prisma.TransactionClient,
) {
  // Serialize against card replacement; an old QR cannot create a valid grant afterward.
  const token = input.code.slice("redlight:".length);
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE "membershipToken" = ${token} FOR UPDATE`;
  const customer = await tx.customer.findUnique({
    where: { membershipToken: token },
  });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound(
      "This membership card is invalid or has been replaced. Ask the owner for help.",
    );
  if (input.customerId && input.customerId !== customer.id)
    throw forbidden(
      "This card belongs to a different customer. Scan the selected customer's card, or return to Scan membership.",
    );
  if (customer.membershipActivatedAt === null)
    await activateRecord(
      actor,
      customer.id,
      tx,
      "Customer presented their membership QR at the counter.",
    );
  await grantCustomerAccess(actor, customer.id, token, tx);
  return { customerId: customer.id };
}

export async function getMembershipCard(actor: Actor, id: string) {
  const customer = await prisma.$transaction(async (tx) => {
    await assertCustomerProfileAccess(actor, id, tx);
    return tx.customer.findUnique({ where: { id } });
  });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound();
  return {
    ...(await membershipCardData(customer)),
    canReplace: actor.isOwner,
    membershipActivated: customer.membershipActivatedAt !== null,
  };
}

/** Shared artwork input; never includes phone, balances or privileged fields. */
export async function membershipCardData(
  customer: Pick<Customer, "id" | "name" | "membershipToken">,
) {
  const qr = await QRCode.toDataURL(`redlight:${customer.membershipToken}`, {
    width: 600,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  return {
    name: customer.name,
    memberNumber: memberNumber(customer.id),
    qr,
  };
}

export async function replaceMembershipCard(
  actor: Actor,
  id: string,
  input: z.infer<typeof replaceMembershipSchema>,
  tx: Prisma.TransactionClient,
) {
  if (!actor.isOwner)
    throw forbidden("Only the owner can replace a lost membership card.");
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE`;
  const customer = await tx.customer.findUnique({ where: { id } });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound();
  await tx.customer.update({
    where: { id },
    data: {
      membershipToken: randomUUID(),
      membershipActivatedAt: customer.membershipActivatedAt ?? new Date(),
    },
  });
  await tx.customerVerification.deleteMany({ where: { customerId: id } });
  await writeAudit(
    actor,
    {
      entity: "Customer",
      entityId: id,
      action: "REPLACE_MEMBERSHIP",
      reason: input.reason,
    },
    tx,
  );
  return { replaced: true };
}
