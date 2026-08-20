/** Phase 3 fraud-control report: tickets awarded by staff (§4.6). */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";
import { AppError, forbidden } from "@/server/errors";

const PAGE_SIZE = 50;

export const ticketAwardReportSchema = z.object({
  shopId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.coerce.number().int().min(0).optional(),
});

export type TicketAwardReportInput = z.infer<typeof ticketAwardReportSchema>;

export interface TicketAwardReportRow {
  businessDate: string;
  shop: { id: string; name: string };
  staff: { id: string; displayName: string };
  ticketsAwarded: number;
  shopRevenue: string;
  ticketsPerThousandRupiah: string | null;
}

export async function listTicketAwardReport(
  actor: Actor,
  input: TicketAwardReportInput
): Promise<{
  rows: TicketAwardReportRow[];
  nextCursor: number | null;
  from: string;
  to: string;
}> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can view ticket-award controls.");
  }

  const to = input.to ? parseDate(input.to) : actor.businessDate;
  const from = input.from
    ? parseDate(input.from)
    : new Date(to.getTime() - 6 * 86_400_000);
  if (from > to) {
    throw new AppError("VALIDATION_FAILED", "The start date must be before the end date.");
  }

  const skip = input.cursor ?? 0;
  const groups = await prisma.ticketLedger.groupBy({
    by: ["businessDate", "shopId", "userId"],
    where: {
      type: "AWARD",
      businessDate: { gte: from, lte: to },
      ...(input.shopId ? { shopId: input.shopId } : {}),
    },
    _sum: { delta: true },
    orderBy: [
      { businessDate: "desc" },
      { shopId: "asc" },
      { userId: "asc" },
    ],
    skip,
    take: PAGE_SIZE + 1,
  });
  const page = groups.slice(0, PAGE_SIZE);

  const shopIds = [...new Set(page.map((row) => row.shopId))];
  const userIds = [...new Set(page.map((row) => row.userId))];
  const [shops, users, sales] = await Promise.all([
    prisma.shop.findMany({
      where: { id: { in: shopIds } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true },
    }),
    prisma.sale.groupBy({
      by: ["businessDate", "shopId"],
      where: {
        status: "COMPLETED",
        businessDate: { gte: from, lte: to },
        ...(input.shopId ? { shopId: input.shopId } : { shopId: { in: shopIds } }),
      },
      _sum: { amount: true },
    }),
  ]);

  const shopById = new Map(shops.map((shop) => [shop.id, shop]));
  const userById = new Map(users.map((user) => [user.id, user]));
  const revenueByDayShop = new Map(
    sales.map((sale) => [
      `${sale.businessDate.toISOString().slice(0, 10)}:${sale.shopId}`,
      sale._sum.amount ?? new Prisma.Decimal(0),
    ])
  );

  return {
    rows: page.map((row) => {
      const date = row.businessDate.toISOString().slice(0, 10);
      const tickets = row._sum.delta ?? 0;
      const revenue =
        revenueByDayShop.get(`${date}:${row.shopId}`) ?? new Prisma.Decimal(0);
      return {
        businessDate: date,
        shop: shopById.get(row.shopId) ?? { id: row.shopId, name: "Unknown shop" },
        staff: userById.get(row.userId) ?? {
          id: row.userId,
          displayName: "Unknown user",
        },
        ticketsAwarded: tickets,
        shopRevenue: revenue.toString(),
        ticketsPerThousandRupiah: revenue.gt(0)
          ? new Prisma.Decimal(tickets)
              .mul(1000)
              .div(revenue)
              .toDecimalPlaces(2)
              .toString()
          : null,
      };
    }),
    nextCursor: groups.length > PAGE_SIZE ? skip + PAGE_SIZE : null,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError("VALIDATION_FAILED", "That date is not valid.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new AppError("VALIDATION_FAILED", "That date is not valid.");
  }
  return date;
}

