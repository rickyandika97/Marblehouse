/**
 * Customers (PRD §4.4, §7.3, §8.5).
 *
 * The phone number is the identity key. It is what lets a marble or ticket
 * balance follow a customer between branches, and it is the ONLY reason the app
 * asks for it — §4.4 says to say so in the UI copy.
 *
 * Balances are NOT written here. Phase 2 creates customers and attaches them to
 * sales; the marble and ticket ledgers arrive in Phase 3, and they own every
 * write to `marbleBalance` / `ticketBalance`.
 */
import { z } from "zod";
import { Prisma, type Customer } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import { normalizePhone, isPlausiblePhone, formatPhoneLocal } from "@/lib/phone";
import type { Actor } from "@/server/auth/context";
import {
  toCustomerDTO,
  toCustomerOwnerDTO,
  type CustomerDTO,
  type CustomerOwnerDTO,
  type CustomerStats,
} from "@/server/dto/customer";

const UNIQUE_VIOLATION = "P2002";

/** NF-4: every list screen paginates. No unbounded queries. */
export const PAGE_SIZE = 50;

/**
 * A phone that normalises to the same key as an existing customer's is a
 * duplicate, which §4.4 relies on to prevent most double records.
 */
const phoneField = z
  .string()
  .trim()
  .min(1, "A phone number is required.")
  .refine(isPlausiblePhone, "That does not look like a phone number.");

export const createCustomerSchema = z.object({
  // §4.4: "Name is required only when a phone number is given" — and a phone
  // number is always given, because a record without one cannot be looked up.
  name: z.string().trim().min(1, "A name is required.").max(120),
  phone: phoneField,
  note: z.string().trim().max(500).optional(),
});

export const updateCustomerSchema = z.object({
  name: z.string().trim().min(1, "A name is required.").max(120).optional(),
  phone: phoneField.optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const searchCustomersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  /**
   * When set and the query is empty, return recent customers AT THIS SHOP
   * rather than globally — the "recent customers at this shop" list the sale
   * screen's picker opens on (§8.2).
   */
  shopId: z.string().optional(),
});

export const mergeCustomersSchema = z
  .object({
    winnerId: z.string().min(1),
    loserId: z.string().min(1),
  })
  .refine((input) => input.winnerId !== input.loserId, {
    message: "Choose two different customers.",
    path: ["loserId"],
  });

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type SearchCustomersInput = z.infer<typeof searchCustomersSchema>;
export type MergeCustomersInput = z.infer<typeof mergeCustomersSchema>;

/**
 * Search by partial phone digits or name (§7.3, §8.5).
 *
 * Staff type digits far more often than letters, so a digits-only query is
 * matched against the normalised number. Filtering happens in SQL (§5.6) —
 * never findMany-then-filter, which is what stops this staying fast at 50.000
 * customers (NF-2).
 */
export async function searchCustomers(
  actor: Actor,
  input: SearchCustomersInput
): Promise<{ customers: CustomerDTO[]; nextCursor: string | null }> {
  const q = input.q?.trim() ?? "";
  const digits = q.replace(/\D/g, "");

  // A query of pure digits is a phone lookup; anything else is a name search.
  // When both are plausible (e.g. "0812") the phone match is what staff mean.
  const where: Prisma.CustomerWhereInput = {
    isActive: true,
    mergedIntoId: null,
    ...(q === ""
      ? // Empty query with a shop in scope → that shop's regulars (§8.2).
        input.shopId
        ? { sales: { some: { shopId: input.shopId, status: "COMPLETED" } } }
        : {}
      : digits.length >= 3
        ? { phoneNormalized: { contains: digits } }
        : { name: { contains: q, mode: "insensitive" } }),
  };

  const rows = await prisma.customer.findMany({
    where,
    orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    take: PAGE_SIZE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, PAGE_SIZE);

  return {
    // Every role gets the restricted shape from search. The owner's analytics
    // live on the detail endpoint, not in a list.
    customers: page.map(toCustomerDTO),
    nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function createCustomer(
  actor: Actor,
  input: CreateCustomerInput
): Promise<CustomerDTO> {
  const phoneNormalized = normalizePhone(input.phone);

  try {
    const customer = await prisma.customer.create({
      data: {
        name: input.name,
        phoneRaw: input.phone,
        phoneNormalized,
        note: input.note ?? null,
      },
    });

    return toCustomerDTO(customer);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === UNIQUE_VIOLATION
    ) {
      // Tell staff who it is, so they pick the existing record instead of
      // inventing a variant phone number to get past the error.
      const existing = await prisma.customer.findUnique({
        where: { phoneNormalized },
      });

      throw new AppError(
        "DUPLICATE_PHONE",
        existing
          ? `${existing.name} already uses ${formatPhoneLocal(phoneNormalized)}.`
          : "That phone number is already registered.",
        existing ? { customerId: existing.id, name: existing.name } : {}
      );
    }
    throw e;
  }
}

export async function updateCustomer(
  actor: Actor,
  id: string,
  input: UpdateCustomerInput
): Promise<CustomerDTO> {
  const existing = await prisma.customer.findUnique({ where: { id } });
  if (!existing || existing.mergedIntoId) {
    throw notFound("That customer no longer exists.");
  }

  const phoneNormalized = input.phone
    ? normalizePhone(input.phone)
    : undefined;

  try {
    const updated = await prisma.customer.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined
          ? { phoneRaw: input.phone, phoneNormalized }
          : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });

    return toCustomerDTO(updated);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === UNIQUE_VIOLATION
    ) {
      throw new AppError(
        "DUPLICATE_PHONE",
        "Another customer already uses that phone number."
      );
    }
    throw e;
  }
}

export async function getCustomer(id: string): Promise<Customer> {
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer || customer.mergedIntoId) {
    throw notFound("That customer no longer exists.");
  }
  return customer;
}

/**
 * Customer detail, shaped by role (§7.3, §8.5).
 *
 * OWNER gets spend, visit history, active days and preferred shop. MANAGER and
 * STAFF get name, phone and balances — requirement 9.1, enforced by calling a
 * different builder, not by trimming one.
 */
export async function getCustomerForActor(
  actor: Actor,
  id: string
): Promise<CustomerDTO | CustomerOwnerDTO> {
  const customer = await getCustomer(id);

  if (actor.role !== "OWNER") {
    return toCustomerDTO(customer);
  }

  return toCustomerOwnerDTO(customer, await customerStats(id));
}

/**
 * Owner-only aggregates (§9 definitions).
 *
 *   Customer lifetime value = SUM(Sale.amount), all time, completed only.
 *   Active days             = distinct businessDate with a completed sale.
 *   Preferred shop          = most completed sales, ties broken by most recent.
 *
 * Aggregated in SQL. Summing Decimals in JavaScript would reintroduce exactly
 * the float problem §4.1 forbids.
 */
async function customerStats(customerId: string): Promise<CustomerStats> {
  const completed = {
    customerId,
    status: "COMPLETED",
  } satisfies Prisma.SaleWhereInput;

  const [totals, activeDays, byShop] = await Promise.all([
    prisma.sale.aggregate({
      where: completed,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.sale
      .findMany({
        where: completed,
        select: { businessDate: true },
        distinct: ["businessDate"],
      })
      .then((rows) => rows.length),
    prisma.sale.groupBy({
      by: ["shopId"],
      where: completed,
      _count: { _all: true },
      _max: { occurredAt: true },
      orderBy: [{ _count: { shopId: "desc" } }, { _max: { occurredAt: "desc" } }],
      take: 1,
    }),
  ]);

  const topShopId = byShop[0]?.shopId ?? null;
  const shop = topShopId
    ? await prisma.shop.findUnique({
        where: { id: topShopId },
        select: { id: true, name: true },
      })
    : null;

  return {
    totalSpend: (totals._sum.amount ?? new Prisma.Decimal(0)).toString(),
    saleCount: totals._count._all,
    activeDays,
    preferredShop: shop,
  };
}

/**
 * Refresh `lastSeenAt` from the customer's remaining completed sales.
 *
 * Called after a void (decision, Phase 2): if the voided sale was the customer's
 * most recent visit, the owner's visit history should not keep claiming they
 * were here. Falls back to `firstSeenAt` when nothing completed remains, so the
 * column is never null and never in the future.
 *
 * Takes a transaction client — this runs inside the void's transaction.
 */
export async function refreshLastSeenAt(
  tx: Prisma.TransactionClient,
  customerId: string
): Promise<void> {
  const latest = await tx.sale.aggregate({
    where: { customerId, status: "COMPLETED" },
    _max: { occurredAt: true },
  });

  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { firstSeenAt: true },
  });
  if (!customer) return;

  await tx.customer.update({
    where: { id: customerId },
    data: { lastSeenAt: latest._max.occurredAt ?? customer.firstSeenAt },
  });
}

/**
 * Merge a duplicate customer into the surviving record (§4.4).
 *
 * Ledger rows stay append-only: ownership moves, but historical
 * `balanceAfter` snapshots are not rewritten. The winner's current caches are
 * recomputed from the combined ledger, which remains the source of truth.
 */
export async function mergeCustomers(
  actor: Actor,
  input: MergeCustomersInput,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<CustomerDTO> {
  if (actor.role !== "OWNER") {
    throw forbidden("Only the owner can merge customer records.");
  }

  // Stable lock order prevents two opposite merge requests deadlocking.
  const ids = [input.winnerId, input.loserId].sort();
  await tx.$queryRaw`
    SELECT id FROM "Customer"
    WHERE id IN (${Prisma.join(ids)})
    ORDER BY id
    FOR UPDATE
  `;

  const [winner, loser] = await Promise.all([
    tx.customer.findUnique({ where: { id: input.winnerId } }),
    tx.customer.findUnique({ where: { id: input.loserId } }),
  ]);
  if (!winner || !winner.isActive || winner.mergedIntoId) {
    throw notFound("The customer to keep no longer exists.");
  }
  if (!loser || !loser.isActive || loser.mergedIntoId) {
    throw notFound("The duplicate customer no longer exists.");
  }

  await Promise.all([
    tx.sale.updateMany({
      where: { customerId: loser.id },
      data: { customerId: winner.id },
    }),
    tx.marbleLedger.updateMany({
      where: { customerId: loser.id },
      data: { customerId: winner.id },
    }),
    tx.ticketLedger.updateMany({
      where: { customerId: loser.id },
      data: { customerId: winner.id },
    }),
    tx.redemption.updateMany({
      where: { customerId: loser.id },
      data: { customerId: winner.id },
    }),
  ]);

  const [marbles, tickets] = await Promise.all([
    tx.marbleLedger.aggregate({
      where: { customerId: winner.id },
      _sum: { delta: true },
    }),
    tx.ticketLedger.aggregate({
      where: { customerId: winner.id },
      _sum: { delta: true },
    }),
  ]);

  const merged = await tx.customer.update({
    where: { id: winner.id },
    data: {
      marbleBalance: marbles._sum.delta ?? 0,
      ticketBalance: tickets._sum.delta ?? 0,
      firstSeenAt:
        winner.firstSeenAt < loser.firstSeenAt
          ? winner.firstSeenAt
          : loser.firstSeenAt,
      lastSeenAt:
        winner.lastSeenAt > loser.lastSeenAt
          ? winner.lastSeenAt
          : loser.lastSeenAt,
    },
  });
  await tx.customer.update({
    where: { id: loser.id },
    data: {
      isActive: false,
      mergedIntoId: winner.id,
      marbleBalance: 0,
      ticketBalance: 0,
    },
  });

  await writeAudit(
    actor,
    {
      entity: "Customer",
      entityId: winner.id,
      action: "MERGE",
      before: {
        winnerId: winner.id,
        loserId: loser.id,
        winnerMarbles: winner.marbleBalance,
        loserMarbles: loser.marbleBalance,
        winnerTickets: winner.ticketBalance,
        loserTickets: loser.ticketBalance,
      },
      after: {
        marbleBalance: merged.marbleBalance,
        ticketBalance: merged.ticketBalance,
        loserMergedIntoId: winner.id,
      },
      reason: `Merged duplicate customer ${loser.name}.`,
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  return toCustomerDTO(merged);
}
