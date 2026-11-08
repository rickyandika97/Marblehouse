import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Customer, Prisma } from "@prisma/client";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
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
    grant.customer.isActive &&
    !grant.customer.mergedIntoId &&
    grant.membershipToken === grant.customer.membershipToken
  );
}

export async function assertCustomerAccess(
  actor: Actor,
  customerId: string,
  tx: Prisma.TransactionClient = prisma,
) {
  if (tx !== prisma)
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`;
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
  await grantCustomerAccess(actor, customer.id, token, tx);
  return { customerId: customer.id };
}

export async function getMembershipCard(actor: Actor, id: string) {
  const customer = await prisma.$transaction(async (tx) => {
    await assertCustomerAccess(actor, id, tx);
    return tx.customer.findUnique({ where: { id } });
  });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound();
  return { ...(await membershipCardData(customer)), canReplace: actor.isOwner };
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
    memberNumber: customer.id.slice(-8).toUpperCase(),
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
    data: { membershipToken: randomUUID() },
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
