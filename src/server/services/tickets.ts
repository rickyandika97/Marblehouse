/** Ticket balance ledger and Phase 3 anti-fraud controls (PRD §4.6). */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";
import { AppError, notFound } from "@/server/errors";
import type { BalanceMutationDTO } from "@/server/dto/ledger";
import { getTicketAwardReasonThreshold } from "./settings";

const MAX_BALANCE_CHANGE = 10_000_000;

export const ticketAwardSchema = z.object({
  customerId: z.string().min(1),
  qty: z.number().int().positive().max(MAX_BALANCE_CHANGE),
  note: z.string().trim().max(500).optional(),
  ticketsCollected: z.literal(true, {
    errorMap: () => ({ message: "Confirm that the tickets were counted and collected." }),
  }),
});

export const ticketAdjustSchema = z.object({
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

export type TicketAwardInput = z.infer<typeof ticketAwardSchema>;
export type TicketAdjustInput = z.infer<typeof ticketAdjustSchema>;

type WorkingActor = Actor & { workSession: NonNullable<Actor["workSession"]> };

const INCLUDE = {
  shop: { select: { id: true, name: true } },
  user: { select: { id: true, displayName: true } },
} satisfies Prisma.TicketLedgerInclude;

export async function awardTickets(
  actor: WorkingActor,
  input: TicketAwardInput,
  tx: Prisma.TransactionClient
): Promise<BalanceMutationDTO> {
  const threshold = await getTicketAwardReasonThreshold();
  if (input.qty > threshold && !input.note?.trim()) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Awards above ${threshold} tickets require a reason.`,
      { fields: { note: `Give a reason for awards above ${threshold} tickets.` } }
    );
  }

  return changeTickets(actor, input.customerId, input.qty, "AWARD", input.note, tx);
}

export async function adjustTickets(
  actor: WorkingActor,
  input: TicketAdjustInput,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<BalanceMutationDTO> {
  const result = await changeTickets(
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
      action: "TICKET_ADJUST",
      shopId: actor.workSession.shopId,
      before: { ticketBalance: result.entry.balanceAfter - input.delta },
      after: { ticketBalance: result.entry.balanceAfter, delta: input.delta },
      reason: input.reason,
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  return result;
}

/**
 * Spend or restore tickets on behalf of a redemption (§4.9, Phase 4).
 *
 * Redemption checkout and its void need the same negative-balance guard as
 * every other ticket movement, so they go through `changeTickets` rather than
 * writing their own `updateMany` — the invariant lives in ONE place and a
 * future change to it cannot miss a caller.
 *
 * `delta` is negative to spend and positive to restore. The caller owns the
 * transaction: the ledger row, the batches and the redemption must commit
 * together or not at all.
 */
export async function applyRedemptionTickets(
  actor: WorkingActor,
  customerId: string,
  delta: number,
  type: "REDEEM" | "VOID_RESTORE",
  reason: string | undefined,
  tx: Prisma.TransactionClient
): Promise<BalanceMutationDTO> {
  return changeTickets(actor, customerId, delta, type, reason, tx);
}

async function changeTickets(
  actor: WorkingActor,
  customerId: string,
  delta: number,
  type: "AWARD" | "ADJUST" | "REDEEM" | "VOID_RESTORE",
  reason: string | undefined,
  tx: Prisma.TransactionClient
): Promise<BalanceMutationDTO> {
  const changed = await tx.customer.updateMany({
    where: {
      id: customerId,
      isActive: true,
      mergedIntoId: null,
      ...(delta < 0 ? { ticketBalance: { gte: -delta } } : {}),
    },
    data: { ticketBalance: { increment: delta } },
  });

  if (changed.count !== 1) {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { isActive: true, mergedIntoId: true, ticketBalance: true },
    });
    if (!customer || !customer.isActive || customer.mergedIntoId) {
      throw notFound("That customer no longer exists.");
    }
    throw new AppError(
      "INSUFFICIENT_TICKETS",
      type === "REDEEM"
        ? `Customer has ${customer.ticketBalance} tickets, but this redemption needs ${-delta}.`
        : `Customer has ${customer.ticketBalance} tickets, but this correction removes ${-delta}.`,
      { balance: customer.ticketBalance, requested: -delta }
    );
  }

  const customer = await tx.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { id: true, marbleBalance: true, ticketBalance: true },
  });

  const entry = await tx.ticketLedger.create({
    data: {
      customerId,
      shopId: actor.workSession.shopId,
      userId: actor.userId,
      type,
      delta,
      balanceAfter: customer.ticketBalance,
      reason: reason?.trim() || null,
      businessDate: actor.businessDate,
    },
    include: INCLUDE,
  });

  return {
    entry: {
      id: entry.id,
      kind: "TICKET",
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

