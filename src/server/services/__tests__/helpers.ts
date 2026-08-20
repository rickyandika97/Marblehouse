/**
 * Test fixtures for the FIFO suite (PRD §15).
 *
 * Everything here runs inside a transaction that is ALWAYS rolled back, so the
 * suite can use the real development database without accumulating rows the way
 * `verify-phase3.sh` does. `withRollback` throws a private sentinel after the
 * body resolves; Prisma unwinds the transaction and we swallow the sentinel.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { Actor, ShopRole } from "@/server/auth/context";

export const prisma = new PrismaClient({ log: [] });

const ROLLBACK = Symbol("rollback");

class Rollback extends Error {
  readonly token = ROLLBACK;
  value: unknown;
  constructor(value: unknown) {
    super("rollback");
    this.value = value;
  }
}

/**
 * Run `body` in a transaction and roll it back unconditionally.
 *
 * The return value is passed back out, so a test can assert on what the body
 * computed even though none of it was committed.
 */
export async function withRollback<T>(
  body: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  try {
    await prisma.$transaction(
      async (tx) => {
        throw new Rollback(await body(tx));
      },
      { timeout: 20_000 }
    );
  } catch (error) {
    if (error instanceof Rollback && error.token === ROLLBACK) {
      return error.value as T;
    }
    throw error;
  }
  throw new Error("unreachable: the transaction should always roll back");
}

/** A unique suffix so fixtures never collide with seed or verify-script data. */
export const uniq = () => randomUUID().slice(0, 8);

export async function makeShop(tx: Prisma.TransactionClient, name = "FIFO Test") {
  const id = uniq();
  return tx.shop.create({
    data: { code: `FIFO-${id}`, name: `${name} ${id}`, timezone: "Asia/Jakarta" },
  });
}

export async function makePrize(
  tx: Prisma.TransactionClient,
  ticketCost = 100
) {
  const id = uniq();
  return tx.prizeItem.create({
    data: { sku: `FIFO-${id}`, name: `FIFO Prize ${id}`, ticketCost },
  });
}

/**
 * Create a batch. `receivedAt` is a plain day offset because FIFO order is the
 * thing under test and relative ordering is what every case is really asserting.
 */
export async function makeBatch(
  tx: Prisma.TransactionClient,
  args: {
    shopId: string;
    prizeItemId: string;
    qty: number;
    unitCogs: number | string;
    dayOffset?: number;
    needsCosting?: boolean;
    isVoid?: boolean;
  }
) {
  const receivedAt = new Date("2026-01-01T00:00:00.000Z");
  receivedAt.setUTCDate(receivedAt.getUTCDate() + (args.dayOffset ?? 0));

  return tx.prizeBatch.create({
    data: {
      shopId: args.shopId,
      prizeItemId: args.prizeItemId,
      qtyReceived: args.qty,
      qtyRemaining: args.qty,
      unitCogs: new Prisma.Decimal(args.unitCogs),
      needsCosting: args.needsCosting ?? false,
      isVoid: args.isVoid ?? false,
      receivedAt,
    },
  });
}

/** Remaining quantities in FIFO order — the shape most assertions want. */
export async function remaining(
  tx: Prisma.TransactionClient,
  shopId: string,
  prizeItemId: string
): Promise<number[]> {
  const batches = await tx.prizeBatch.findMany({
    where: { shopId, prizeItemId, isVoid: false },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    select: { qtyRemaining: true },
  });
  return batches.map((b) => b.qtyRemaining);
}

export const BUSINESS_DATE = new Date("2026-01-15T00:00:00.000Z");

/**
 * Build an in-memory `Actor` for a test (D-122: role is per-shop, so the
 * shape here is a map, not a scalar).
 *
 * `role: "OWNER"` gives a global owner (no shop assignments possible or
 * needed). `role: "MANAGER" | "STAFF"` with `shopIds` gives that role at
 * EVERY listed shop — for a fixture that needs different roles at different
 * shops, build `shopRoles` directly instead of using this helper.
 *
 * Does not create a database row — callers that need one (most FK-writing
 * services do) should create the `User` row themselves and override
 * `userId`, or use `makeActorWithUser` below.
 */
export function makeActor(opts: {
  role: "OWNER" | "MANAGER" | "STAFF";
  shopIds?: string[];
  canEnterCost?: boolean;
  userId?: string;
  defaultShopId?: string | null;
  businessDate?: Date;
}): Actor {
  const id = uniq();
  const shopRoles = new Map<string, ShopRole>();
  if (opts.role !== "OWNER") {
    for (const shopId of opts.shopIds ?? []) {
      shopRoles.set(shopId, {
        role: opts.role,
        canEnterCost: opts.canEnterCost ?? false,
      });
    }
  }
  return {
    sessionId: `sess-${id}`,
    userId: opts.userId ?? `user-${id}`,
    username: `test-${id}`,
    displayName: `Test ${id}`,
    isOwner: opts.role === "OWNER",
    shopRoles,
    isActive: true,
    mustChangePassword: false,
    defaultShopId: opts.defaultShopId ?? null,
    businessDate: opts.businessDate ?? BUSINESS_DATE,
    workSession: null,
  } as unknown as Actor;
}

/**
 * `makeActor`, plus a real `User` row the foreign keys can point at (and a
 * matching `UserShop` row per shop, with the real per-shop role). Use this
 * whenever the service under test writes a foreign key to the actor
 * (`userId`, `createdById`, `recordedById`, ...) — a fabricated id would fail
 * on the constraint rather than on the behaviour under test.
 */
export async function makeActorWithUser(
  tx: Prisma.TransactionClient,
  opts: {
    role: "OWNER" | "MANAGER" | "STAFF";
    shopIds?: string[];
    canEnterCost?: boolean;
    defaultShopId?: string | null;
    businessDate?: Date;
  }
): Promise<Actor> {
  const id = uniq();
  const user = await tx.user.create({
    data: {
      email: `test-${id}@marblehouse.invalid`,
      name: `Test ${id}`,
      username: `test-${id}`,
      displayName: `Test ${id}`,
      isOwner: opts.role === "OWNER",
      defaultShopId: opts.defaultShopId ?? undefined,
    },
  });

  if (opts.role !== "OWNER") {
    for (const shopId of opts.shopIds ?? []) {
      await tx.userShop.create({
        data: {
          userId: user.id,
          shopId,
          role: opts.role,
          canEnterCost: opts.canEnterCost ?? false,
        },
      });
    }
  }

  return makeActor({ ...opts, userId: user.id });
}
