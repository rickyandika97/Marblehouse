/**
 * Dev fixtures for the inventory screen (D-156).
 *
 * Five `VD-` prizes at MKG with three FIFO lots each at rising costs, plus
 * real consumption booked through `consumeFifo` so the batch drill-down has
 * genuine history — a redemption spanning two lots, and a damage movement
 * carrying a reason.
 *
 * Safe to re-run: every write is an upsert or guarded by an existence check,
 * so it will not double-book stock. Run it after `npm run db:reset` to get the
 * inventory screen back into a state worth looking at:
 *
 *     npx tsx scripts/seed-inventory-fixtures.ts
 *
 * Dev only. The shop ids below are this machine's; it refuses elsewhere.
 */
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();

const MKG = "cmt12euko0000qkawrhbkqyd1";
const PIK = "cmt17e1mj000oqkeuad2fzvfq";

async function main() {
  // Same rule the test suite follows — never touch a non-dev database.
  const url = process.env.DATABASE_URL ?? "";
  if (!/_dev|_test/.test(url)) {
    throw new Error(`Refusing to seed fixtures into ${url || "an unset DATABASE_URL"}.`);
  }

  const owner = await prisma.user.findFirstOrThrow({ where: { username: "owner" } });
  const dewa = await prisma.user.findFirstOrThrow({ where: { username: "dewa" } });

  const specs = [
    { sku: "VD-TEDDY", name: "Teddy Bear Large", cat: "Plush", tc: 1200, thr: 10 },
    { sku: "VD-CAR",   name: "Die-cast Car",     cat: "Toys",  tc: 450,  thr: 20 },
    { sku: "VD-BALL",  name: "Bouncy Ball",      cat: "Toys",  tc: 80,   thr: 50 },
    { sku: "VD-PUZZ",  name: "Puzzle Cube",      cat: "Games", tc: 600,  thr: 5  },
    { sku: "VD-KEY",   name: "Keychain Charm",   cat: "Small", tc: 60,   thr: 0  },
  ];

  for (const s of specs) {
    const prize = await prisma.prizeItem.upsert({
      where: { sku: s.sku },
      update: {},
      create: { sku: s.sku, name: s.name, category: s.cat, ticketCost: s.tc },
    });

    await prisma.shopPrizeConfig.upsert({
      where: { shopId_prizeItemId: { shopId: MKG, prizeItemId: prize.id } },
      update: { isActive: true, lowStockThreshold: s.thr },
      create: { shopId: MKG, prizeItemId: prize.id, isActive: true, lowStockThreshold: s.thr },
    });

    const existing = await prisma.prizeBatch.count({ where: { shopId: MKG, prizeItemId: prize.id } });
    if (existing > 0) continue;

    // Three lots at rising costs, so FIFO order is visible and meaningful.
    const costs = [ [40, 5000], [30, 6500], [25, 7200] ] as const;
    let day = 0;
    for (const [qty, cogs] of costs) {
      const receivedAt = new Date("2026-06-01T02:00:00.000Z");
      receivedAt.setUTCDate(receivedAt.getUTCDate() + day);
      day += 20;
      await prisma.prizeBatch.create({
        data: {
          shopId: MKG, prizeItemId: prize.id,
          batchCode: `${s.sku}-L${day}`,
          qtyReceived: qty, qtyRemaining: qty,
          unitCogs: new Prisma.Decimal(cogs),
          supplier: day === 20 ? "PT Mainan Jaya" : "CV Sumber Toys",
          receivedAt, createdById: owner.id,
        },
      });
    }
  }

  // One lot at PIK too, so transfers have somewhere to land.
  const teddy = await prisma.prizeItem.findFirstOrThrow({ where: { sku: "VD-TEDDY" } });
  await prisma.shopPrizeConfig.upsert({
    where: { shopId_prizeItemId: { shopId: PIK, prizeItemId: teddy.id } },
    update: { isActive: true, lowStockThreshold: 5 },
    create: { shopId: PIK, prizeItemId: teddy.id, isActive: true, lowStockThreshold: 5 },
  });

  // --- Real consumption through the engine, so history is genuine. ---
  const { consumeFifo } = await import("../src/server/services/inventory");

  const customer = await prisma.customer.upsert({
    where: { phoneNormalized: "+628111222333" },
    update: {},
    create: { name: "Ibu Sari", phoneRaw: "08111222333", phoneNormalized: "+628111222333" },
  });

  const bd = new Date("2026-08-20T00:00:00.000Z");

  const car = await prisma.prizeItem.findFirstOrThrow({ where: { sku: "VD-CAR" } });
  const already = await prisma.stockMovement.count({ where: { shopId: MKG, prizeItemId: car.id } });
  if (already === 0) {
    // A redemption that spans two lots — the interesting FIFO case.
    const redemption = await prisma.redemption.create({
      data: { shopId: MKG, customerId: customer.id, userId: dewa.id, totalTickets: 20250, totalCogs: new Prisma.Decimal(0), businessDate: bd },
    });
    await prisma.$transaction((tx) =>
      consumeFifo(tx, { shopId: MKG, prizeItemId: car.id, qty: 45, type: "REDEEM", businessDate: bd, userId: dewa.id, refType: "Redemption", refId: redemption.id })
    );
    // A breakage, with a reason.
    await prisma.$transaction((tx) =>
      consumeFifo(tx, { shopId: MKG, prizeItemId: car.id, qty: 3, type: "DAMAGE", businessDate: bd, userId: owner.id, reason: "Dropped by a customer at the counter" })
    );
    // And a smaller redemption on the teddy.
    const r2 = await prisma.redemption.create({
      data: { shopId: MKG, customerId: customer.id, userId: dewa.id, totalTickets: 6000, totalCogs: new Prisma.Decimal(0), businessDate: bd },
    });
    await prisma.$transaction((tx) =>
      consumeFifo(tx, { shopId: MKG, prizeItemId: teddy.id, qty: 5, type: "REDEEM", businessDate: bd, userId: dewa.id, refType: "Redemption", refId: r2.id })
    );
  }

  console.log("seeded");
}

main().finally(() => prisma.$disconnect());
