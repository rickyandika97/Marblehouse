/** Marble balance ledger (PRD §4.5, §7.3). */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";
import { AppError, notFound } from "@/server/errors";
import type { BalanceMutationDTO } from "@/server/dto/ledger";

const MAX_BALANCE_CHANGE = 1_000_000;

export const marbleChangeSchema = z.object({
  customerId: z.string().min(1),
  qty: z.number().int().positive().max(MAX_BALANCE_CHANGE),
  note: z.string().trim().max(500).optional(),
});

export const marbleAdjustSchema = z.object({
  customerId: z.string().min(1),
  delta: z
    .number()
    .int()
    .min(-MAX_BALANCE_CHANGE)
    .max(MAX_BALANCE_CHANGE)
    .refine((value) => value !== 0, "Adjustment cannot be zero."),
  reason: z
    .string()
    .trim()
    .min(3, "Say why this balance is being corrected.")
    .max(500),
});

export type MarbleChangeInput = z.infer<typeof marbleChangeSchema>;
export type MarbleAdjustInput = z.infer<typeof marbleAdjustSchema>;

type WorkingActor = Actor & { workSession: NonNullable<Actor["workSession"]> };

const INCLUDE = {
  shop: { select: { id: true, name: true } },
  user: { select: { id: true, displayName: true } },
} satisfies Prisma.MarbleLedgerInclude;

export async function depositMarbles(
  actor: WorkingActor,
  input: MarbleChangeInput,
  tx: Prisma.TransactionClient
): Promise<BalanceMutationDTO> {
  return changeMarbles(actor, input.customerId, input.qty, "DEPOSIT", input.note, tx);
}

export async function withdrawMarbles(
  actor: WorkingActor,
  input: MarbleChangeInput,
  tx: Prisma.TransactionClient
): Promise<BalanceMutationDTO> {
  return changeMarbles(actor, input.customerId, -input.qty, "WITHDRAW", input.note, tx);
}

export async function adjustMarbles(
  actor: WorkingActor,
  input: MarbleAdjustInput,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<BalanceMutationDTO> {
  const result = await changeMarbles(
    actor,
    input.customerId,
    input.delta,
    "ADJUST",
    input.reason,
    tx
  );

  await writeAudit(
    actor,
    {
      entity: "Customer",
      entityId: input.customerId,
      action: "MARBLE_ADJUST",
      shopId: actor.workSession.shopId,
      before: { marbleBalance: result.entry.balanceAfter - input.delta },
      after: { marbleBalance: result.entry.balanceAfter, delta: input.delta },
      reason: input.reason,
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  return result;
}

async function changeMarbles(
  actor: WorkingActor,
  customerId: string,
  delta: number,
  type: "DEPOSIT" | "WITHDRAW" | "ADJUST",
  reason: string | undefined,
  tx: Prisma.TransactionClient
): Promise<BalanceMutationDTO> {
  const changed = await tx.customer.updateMany({
    where: {
      id: customerId,
      isActive: true,
      mergedIntoId: null,
      ...(delta < 0 ? { marbleBalance: { gte: -delta } } : {}),
    },
    data: { marbleBalance: { increment: delta } },
  });

  if (changed.count !== 1) {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { isActive: true, mergedIntoId: true, marbleBalance: true },
    });
    if (!customer || !customer.isActive || customer.mergedIntoId) {
      throw notFound("That customer no longer exists.");
    }
    throw new AppError(
      "INSUFFICIENT_MARBLES",
      `Customer has ${customer.marbleBalance} stored marbles, but this withdrawal needs ${-delta}.`,
      { balance: customer.marbleBalance, requested: -delta }
    );
  }

  const customer = await tx.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { id: true, marbleBalance: true, ticketBalance: true },
  });

  const entry = await tx.marbleLedger.create({
    data: {
      customerId,
      shopId: actor.workSession.shopId,
      userId: actor.userId,
      type,
      delta,
      balanceAfter: customer.marbleBalance,
      reason: reason?.trim() || null,
      businessDate: actor.businessDate,
    },
    include: INCLUDE,
  });

  return {
    entry: {
      id: entry.id,
      kind: "MARBLE",
      type: entry.type,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      businessDate: entry.businessDate.toISOString().slice(0, 10),
      occurredAt: entry.occurredAt.toISOString(),
      shop: entry.shop,
      recordedBy: entry.user,
    },
    customer,
  };
}

