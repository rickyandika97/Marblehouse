/**
 * Demo dataset (PRD §10) — `npm run db:seed -- --demo`.
 *
 * Generates a realistic body of data so Phase 8's reports can be judged
 * against something with shape: 3 extra branches, ~200 customers, ~2000 sales
 * across 60 business days, prize batches, redemptions and attendance.
 *
 * TWO PROPERTIES MATTER MORE THAN REALISM, and both are deliberate:
 *
 * 1. **It is reproducible.** Every random choice comes from `mulberry32`
 *    seeded with a fixed constant, so the same command produces the same
 *    database every time. §16 accepts Phase 8 when "every metric matches a
 *    hand-calculation against the demo dataset" — a hand-calculation against a
 *    dataset that changes on every run is worthless the moment you re-run it.
 *    Do not replace these calls with `Math.random()`.
 *
 * 2. **It is removable.** Every row this file creates is reachable from a shop
 *    whose `code` starts with `DEMO-`, or is a customer/prize/category whose
 *    name carries DEMO_TAG. `--reset-demo` deletes exactly those, in foreign-key
 *    order, and nothing else. Demo data drifting into production is the failure
 *    §10 warns about.
 *
 * The dataset is intentionally NOT uniform: shops have different volumes, one
 * branch runs a deliberately high shrinkage rate, and one staff member awards
 * tickets at roughly double the going rate. Flat data would let a broken
 * report look correct — every shop showing the same number hides a grouping
 * bug, and the §4.6 fraud ratio has nothing to detect.
 *
 * For the same reason, shrinkage is split across BOTH `OPNAME_LOSS` and
 * `DAMAGE` (D-90). A category the fixture never produces is a category no
 * fixture-driven check can test — the shrinkage split had exactly that hole.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import type { PaymentMethod } from "@prisma/client";
import { auth } from "../src/server/auth/auth";
import { businessDateFor } from "../src/lib/business-date";

/** Marks every demo row that is not attached to a DEMO- shop. */
export const DEMO_TAG = "[demo]";
const DEMO_SHOP_PREFIX = "DEMO-";

/** Fixed so the dataset is byte-for-byte reproducible. Do not randomise. */
const RANDOM_SEED = 0x6d61726b;
const DAYS = 60;
const CUSTOMER_COUNT = 200;

/**
 * Deterministic PRNG. Small, fast, and — the only property we actually need —
 * identical on every machine and every run for a given seed.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next: () => number;
  int: (minInclusive: number, maxInclusive: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (probability: number) => boolean;
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T,>(items: readonly T[]) => items[int(0, items.length - 1)]!,
    chance: (probability: number) => next() < probability,
  };
}

const FIRST_NAMES = [
  "Budi", "Siti", "Agus", "Dewi", "Eko", "Rina", "Joko", "Ayu", "Bayu", "Sari",
  "Dian", "Fajar", "Indah", "Rizky", "Putri", "Andi", "Lestari", "Hendra",
  "Maya", "Yudi",
];
const LAST_NAMES = [
  "Santoso", "Wijaya", "Pratama", "Kusuma", "Hartono", "Nugroho", "Setiawan",
  "Halim", "Wibowo", "Permata",
];
const PRIZE_NAMES = [
  "Plush Bear", "Water Bottle", "Keychain", "Puzzle Cube", "Toy Car",
  "Sticker Pack", "Notebook", "Sunglasses", "Backpack", "Headphones",
  "Desk Lamp", "Board Game",
];
const SUPPLIERS = ["Toko Mainan Jaya", "CV Sumber Rejeki", "PT Prima Toys"];

/** Sale preset amounts, matching the seeded defaults (§10). */
const PRESET_AMOUNTS = [20000, 50000, 100000, 200000, 500000];

function midday(businessDate: Date, hour: number, minute: number): Date {
  // Business dates are UTC-midnight DATEs. Asia/Jakarta is UTC+7 with no DST,
  // so a local wall-clock hour is that hour minus 7 in UTC. Every generated
  // timestamp lands between 10:00 and 23:00 local, comfortably inside one
  // business day so the 04:00 cutoff never reassigns a row (§4.2).
  const d = new Date(businessDate);
  d.setUTCHours(hour - 7, minute, 0, 0);
  return d;
}

export async function seedDemo(prisma: PrismaClient): Promise<void> {
  const rng = makeRng(RANDOM_SEED);
  const timezone = process.env.TZ || "Asia/Jakarta";

  const existing = await prisma.shop.count({
    where: { code: { startsWith: DEMO_SHOP_PREFIX } },
  });
  if (existing > 0) {
    throw new Error(
      `Demo data is already present (${existing} demo shops). ` +
        `Run "npm run db:seed -- --reset-demo" first if you want to regenerate it.`
    );
  }

  console.log("\n  Generating demo data (fixed seed — reproducible)…");

  // ── Shops ──────────────────────────────────────────────────────────
  // Three EXTRA branches (§10) alongside the real seed's Branch 1. Different
  // sale volumes so a per-shop grouping bug cannot hide behind equal numbers.
  const shopSpecs = [
    // Shrinkage rates are per-DAY probabilities over 60 days. They were 0.02 /
    // 0.02 / 0.12, which produced only ~5 shrinkage movements in the whole
    // dataset — too thin for the §9 shrinkage report to be judged against, and
    // thin enough that the per-shop breakdown had a branch with none at all.
    // Raised so every branch carries both kinds (D-90).
    { code: "DEMO-A", name: `Demo Mall Branch ${DEMO_TAG}`, weight: 1.0, shrinkage: 0.15 },
    { code: "DEMO-B", name: `Demo Plaza Branch ${DEMO_TAG}`, weight: 0.65, shrinkage: 0.15 },
    // Deliberately higher than the others: gives the §9 "shrinkage expense"
    // line and the owner's variance report a branch that stands out.
    { code: "DEMO-C", name: `Demo Station Branch ${DEMO_TAG}`, weight: 0.4, shrinkage: 0.4 },
  ];

  const shops = [];
  for (const spec of shopSpecs) {
    shops.push(
      await prisma.shop.create({
        data: {
          code: spec.code,
          name: spec.name,
          timezone,
          lateGraceMin: 5,
          presets: {
            create: PRESET_AMOUNTS.map((amount, i) => ({
              label: `Rp ${amount.toLocaleString("id-ID")}`,
              amount: new Prisma.Decimal(amount),
              sortOrder: i + 1,
            })),
          },
          shifts: {
            create: [
              {
                name: "Morning",
                startTime: new Date("1970-01-01T10:00:00.000Z"),
                endTime: new Date("1970-01-01T18:00:00.000Z"),
              },
              {
                name: "Evening",
                startTime: new Date("1970-01-01T18:00:00.000Z"),
                endTime: new Date("1970-01-01T23:00:00.000Z"),
              },
            ],
          },
        },
        include: { presets: true, shifts: true },
      })
    );
  }
  console.log(`  ✔ ${shops.length} demo branches`);

  // ── Staff ──────────────────────────────────────────────────────────
  // One manager and two staff per branch. Created through Better Auth so each
  // has a real argon2id credential — a directly-inserted row would have no
  // password and could not be used to check the reports by hand (§5.4, D-1).
  const staffByShop = new Map<string, string[]>();
  const allStaffIds: string[] = [];
  for (const [i, shop] of shops.entries()) {
    const ids: string[] = [];
    const people = [
      { username: `demo_mgr${i + 1}`, name: `Demo Manager ${i + 1}`, role: "MANAGER" as const },
      { username: `demo_staff${i * 2 + 1}`, name: `Demo Staff ${i * 2 + 1}`, role: "STAFF" as const },
      { username: `demo_staff${i * 2 + 2}`, name: `Demo Staff ${i * 2 + 2}`, role: "STAFF" as const },
    ];
    for (const person of people) {
      const created = await auth.api.createUser({
        body: {
          email: `${person.username}@marblehouse.invalid`,
          password: "DemoPass2026!",
          name: `${person.name} ${DEMO_TAG}`,
          data: {
            username: person.username,
            displayUsername: person.username,
            displayName: `${person.name} ${DEMO_TAG}`,
            role: person.role,
            defaultShopId: shop.id,
            mustChangePassword: false,
          },
        },
      });
      await prisma.userShop.create({
        data: { userId: created.user.id, shopId: shop.id },
      });
      ids.push(created.user.id);
      allStaffIds.push(created.user.id);
    }
    staffByShop.set(shop.id, ids);
  }
  console.log(`  ✔ ${allStaffIds.length} demo staff accounts (password: DemoPass2026!)`);

  // ── Customers ──────────────────────────────────────────────────────
  const customerIds: string[] = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
    // A reserved, non-routable prefix so a demo row can never collide with a
    // real customer's phone number, which is the unique lookup key (§4.4).
    const phone = `+6299${String(1000000 + i).padStart(8, "0")}`;
    const customer = await prisma.customer.create({
      data: {
        name: `${name} ${DEMO_TAG}`,
        phoneRaw: phone,
        phoneNormalized: phone,
      },
    });
    customerIds.push(customer.id);
  }
  console.log(`  ✔ ${customerIds.length} demo customers`);

  // ── Prize catalog and batches ──────────────────────────────────────
  const prizeItems = [];
  for (const [i, name] of PRIZE_NAMES.entries()) {
    prizeItems.push(
      await prisma.prizeItem.create({
        data: {
          sku: `DEMO-SKU-${String(i + 1).padStart(3, "0")}`,
          name: `${name} ${DEMO_TAG}`,
          category: "Demo",
          ticketCost: [50, 80, 120, 200, 350, 500][i % 6]!,
        },
      })
    );
  }

  const today = businessDateFor(new Date(), timezone, 4);
  const dayMs = 86_400_000;
  const businessDates = Array.from(
    { length: DAYS },
    (_, i) => new Date(today.getTime() - (DAYS - 1 - i) * dayMs)
  );

  // Stock every prize at every branch, and receive it in TWO batches at
  // different costs. Two costs is the minimum that makes FIFO observable: with
  // one cost per item, consuming the wrong batch first produces the same
  // number and §15.6 would have nothing to catch.
  for (const shop of shops) {
    for (const prize of prizeItems) {
      await prisma.shopPrizeConfig.create({
        data: { shopId: shop.id, prizeItemId: prize.id, lowStockThreshold: 5 },
      });
      const baseCost = rng.int(2, 20) * 500;
      for (const [batchIndex, offset] of [DAYS + 5, DAYS - 20].entries()) {
        const receivedAt = midday(
          new Date(today.getTime() - offset * dayMs),
          9,
          0
        );
        const qty = rng.int(30, 80);
        const batch = await prisma.prizeBatch.create({
          data: {
            shopId: shop.id,
            prizeItemId: prize.id,
            qtyReceived: qty,
            qtyRemaining: qty,
            // Second batch costs more — the classic case where consuming
            // newest-first would understate prize expense.
            unitCogs: new Prisma.Decimal(baseCost + batchIndex * 500),
            supplier: rng.pick(SUPPLIERS),
            batchCode: `${shop.code}-${prize.id.slice(-4)}-${batchIndex + 1}`,
            receivedAt,
          },
        });
        await prisma.stockMovement.create({
          data: {
            shopId: shop.id,
            prizeItemId: prize.id,
            type: "RECEIVE",
            qtyDelta: qty,
            refType: "PrizeBatch",
            refId: batch.id,
            businessDate: businessDateFor(receivedAt, timezone, 4),
            occurredAt: receivedAt,
          },
        });
      }
    }
  }
  console.log(`  ✔ ${prizeItems.length} prizes, stocked in 2 batches at each branch`);

  // ── 60 days of sales, tickets, redemptions and attendance ──────────
  let saleCount = 0;
  let redemptionCount = 0;
  let attendanceCount = 0;

  for (const businessDate of businessDates) {
    const dow = new Date(businessDate).getUTCDay();
    // Weekends are busier — a flat daily volume would let a date-grouping bug
    // pass unnoticed on the dashboard's 30-day trend.
    const dayFactor = dow === 0 || dow === 6 ? 1.6 : 1.0;

    for (const [shopIndex, shop] of shops.entries()) {
      const spec = shopSpecs[shopIndex]!;
      const staffIds = staffByShop.get(shop.id)!;
      const salesToday = Math.round(rng.int(8, 16) * spec.weight * dayFactor);

      // ── Attendance: one record per staff member per day ──────────
      for (const [staffIndex, userId] of staffIds.entries()) {
        if (rng.chance(0.08)) continue; // an occasional absence
        const shift = shop.shifts[staffIndex === 0 ? 0 : rng.int(0, 1)]!;
        const shiftStartHour = shift.startTime.getUTCHours();
        // Most arrive on time; a fifth are late, occasionally badly.
        const lateMinutes = rng.chance(0.2) ? rng.int(6, 45) : rng.int(-20, 4);
        const clockInAt = midday(
          businessDate,
          shiftStartHour,
          0
        );
        clockInAt.setUTCMinutes(clockInAt.getUTCMinutes() + lateMinutes);
        const isLate = lateMinutes > 5;
        await prisma.attendance.create({
          data: {
            userId,
            shopId: shop.id,
            shiftId: shift.id,
            businessDate,
            clockInAt,
            shiftStartAtCapture: shift.startTime,
            graceMinAtCapture: 5,
            isLate,
            lateMinutes: isLate ? lateMinutes : 0,
            status: isLate ? "LATE" : "PRESENT",
            locationDenied: rng.chance(0.05),
            photoPath: null,
          },
        });
        attendanceCount++;
      }

      for (let s = 0; s < salesToday; s++) {
        const staffId = rng.pick(staffIds);
        const amount = rng.pick(PRESET_AMOUNTS);
        const preset = shop.presets.find((p) => Number(p.amount) === amount)!;
        const occurredAt = midday(businessDate, rng.int(10, 22), rng.int(0, 59));
        // ~30% walk-ins (§9 counts them separately), the rest identified.
        const customerId = rng.chance(0.7) ? rng.pick(customerIds) : null;
        const paymentMethod: PaymentMethod = rng.chance(0.75) ? "CASH" : "EDC";
        // A small number of sales are voided, so "revenue excludes voids"
        // (§9) is actually exercised rather than assumed.
        const voided = rng.chance(0.03);

        await prisma.sale.create({
          data: {
            shopId: shop.id,
            recordedById: staffId,
            customerId,
            presetId: preset.id,
            amount: new Prisma.Decimal(amount),
            paymentMethod,
            status: voided ? "VOIDED" : "COMPLETED",
            businessDate,
            occurredAt,
            ...(voided
              ? {
                  voidedAt: new Date(occurredAt.getTime() + 600_000),
                  voidedById: staffId,
                  voidReason: `Demo void ${DEMO_TAG}`,
                }
              : {}),
          },
        });
        saleCount++;

        if (customerId && !voided) {
          await prisma.customer.update({
            where: { id: customerId },
            data: { lastSeenAt: occurredAt },
          });

          // Ticket award. Staff index 1 at each shop awards roughly double —
          // the §4.6 fraud ratio needs a genuine outlier to detect, or the
          // "tickets per Rp 1.000" report proves nothing.
          if (rng.chance(0.8)) {
            const generous = staffId === staffIds[1];
            const tickets = Math.round((amount / 1000) * (generous ? 4 : 2) * (0.8 + rng.next() * 0.4));
            const customer = await prisma.customer.update({
              where: { id: customerId },
              data: { ticketBalance: { increment: tickets } },
            });
            await prisma.ticketLedger.create({
              data: {
                customerId,
                shopId: shop.id,
                userId: staffId,
                type: "AWARD",
                delta: tickets,
                balanceAfter: customer.ticketBalance,
                businessDate,
                occurredAt,
              },
            });
          }

          // Marble deposit / withdrawal — the §9 outstanding-marbles liability.
          if (rng.chance(0.25)) {
            const deposit = rng.chance(0.6);
            const current = await prisma.customer.findUniqueOrThrow({
              where: { id: customerId },
              select: { marbleBalance: true },
            });
            const delta = deposit
              ? rng.int(5, 40)
              : -Math.min(current.marbleBalance, rng.int(5, 30));
            if (delta !== 0) {
              const updated = await prisma.customer.update({
                where: { id: customerId },
                data: { marbleBalance: { increment: delta } },
              });
              await prisma.marbleLedger.create({
                data: {
                  customerId,
                  shopId: shop.id,
                  userId: staffId,
                  type: delta > 0 ? "DEPOSIT" : "WITHDRAW",
                  delta,
                  balanceAfter: updated.marbleBalance,
                  businessDate,
                  occurredAt,
                },
              });
            }
          }
        }
      }

      // ── Redemptions ────────────────────────────────────────────────
      // Consumes real FIFO batches and records unitCogsAtConsumption, because
      // §9's prize expense is the SUM of those rows — a redemption written
      // without consumption rows would make prize expense silently zero.
      const redemptionsToday = Math.max(1, Math.round(rng.int(1, 4) * spec.weight));
      for (let r = 0; r < redemptionsToday; r++) {
        const customerId = rng.pick(customerIds);
        const customer = await prisma.customer.findUniqueOrThrow({
          where: { id: customerId },
          select: { ticketBalance: true },
        });
        const prize = rng.pick(prizeItems);
        const qty = rng.int(1, 2);
        const ticketCostTotal = prize.ticketCost * qty;
        if (customer.ticketBalance < ticketCostTotal) continue;

        const occurredAt = midday(businessDate, rng.int(12, 21), rng.int(0, 59));
        const consumed = await consumeFifoForDemo(
          prisma,
          shop.id,
          prize.id,
          qty,
          "REDEEM",
          businessDate,
          occurredAt
        );
        if (!consumed) continue;

        const redemption = await prisma.redemption.create({
          data: {
            shopId: shop.id,
            customerId,
            userId: rng.pick(staffIds),
            totalTickets: ticketCostTotal,
            totalCogs: consumed.totalCogs,
            businessDate,
            occurredAt,
            lines: {
              create: [
                {
                  prizeItemId: prize.id,
                  qty,
                  ticketCostEach: prize.ticketCost,
                  ticketCostTotal,
                  cogsTotal: consumed.totalCogs,
                  movementId: consumed.movementId,
                },
              ],
            },
          },
        });

        const updated = await prisma.customer.update({
          where: { id: customerId },
          data: { ticketBalance: { decrement: ticketCostTotal } },
        });
        await prisma.ticketLedger.create({
          data: {
            customerId,
            shopId: shop.id,
            userId: rng.pick(staffIds),
            type: "REDEEM",
            delta: -ticketCostTotal,
            balanceAfter: updated.ticketBalance,
            redemptionId: redemption.id,
            businessDate,
            occurredAt,
          },
        });
        redemptionCount++;
      }

      // ── Shrinkage ──────────────────────────────────────────────────
      // OPNAME_LOSS and DAMAGE, never REDEEM. §9 reports shrinkage separately
      // from prize expense precisely so theft cannot hide inside cost of goods
      // sold, and it reports the two shrinkage KINDS separately again — a
      // count that came up short is a different problem from a crushed box.
      //
      // Both types must appear in the fixture. D-90: the seed used to write
      // OPNAME_LOSS only, so a bug that misfiled DAMAGE as OPNAME_LOSS was
      // unobservable in the demo data — `verify-phase10.sh` had to recompute
      // the split from independent SQL to catch it. That workaround stays
      // (it is the stronger check), but the fixture can now express the bug.
      //
      // The split reuses the SAME rng draw rather than adding one: a new call
      // here would shift every subsequent draw and change every documented
      // demo figure (D-61 — the seed is fixed so the numbers are checkable).
      if (rng.chance(spec.shrinkage)) {
        const prize = rng.pick(prizeItems);
        const qty = rng.int(1, 3);
        // Roughly a third damage, two thirds count shortfall. Keyed off the
        // qty already drawn, so the mix is deterministic and needs no new
        // randomness — qty 3 is the damage case.
        const type = qty === 3 ? "DAMAGE" : "OPNAME_LOSS";
        await consumeFifoForDemo(
          prisma,
          shop.id,
          prize.id,
          qty,
          type,
          businessDate,
          midday(businessDate, 20, 0)
        );
      }
    }
  }
  console.log(`  ✔ ${saleCount} sales, ${redemptionCount} redemptions, ${attendanceCount} attendance records over ${DAYS} days`);

  // ── Expenses ───────────────────────────────────────────────────────
  const categories = await prisma.expenseCategory.findMany({
    where: { isArchived: false },
  });
  let expenseCount = 0;
  if (categories.length > 0) {
    for (const shop of shops) {
      // Monthly fixed costs on the 1st, plus scattered variable costs.
      for (const businessDate of businessDates) {
        const dayOfMonth = new Date(businessDate).getUTCDate();
        const isFirst = dayOfMonth === 1;
        if (!isFirst && !rng.chance(0.12)) continue;
        const category = isFirst
          ? categories.find((c) => c.name === "Rent") ?? rng.pick(categories)
          : rng.pick(categories);
        const amount = isFirst ? rng.int(8, 15) * 1_000_000 : rng.int(5, 80) * 10_000;
        await prisma.expense.create({
          data: {
            shopId: shop.id,
            categoryId: category.id,
            amount: new Prisma.Decimal(amount),
            businessDate,
            note: `Demo expense ${DEMO_TAG}`,
            userId: staffByShop.get(shop.id)![0]!,
          },
        });
        expenseCount++;
      }
    }
  }
  console.log(`  ✔ ${expenseCount} demo expenses`);

  console.log(
    `\n  Demo data complete. Remove it with: npm run db:seed -- --reset-demo\n`
  );
}

/**
 * A local FIFO consumer for seeding only.
 *
 * This deliberately does NOT call `services/inventory.ts`. That engine takes an
 * `Actor` and enforces permissions, and the seed has no request context to give
 * it; inventing a fake actor to satisfy it would be worse. The arithmetic here
 * is a faithful copy of the same ordering rule (`receivedAt ASC, id ASC`) and
 * records `unitCogsAtConsumption` identically, which is what §9's prize expense
 * sums.
 *
 * CLAUDE.md's "FIFO lives in one file" rule governs the APPLICATION. This is a
 * seed script generating fixture data, not a code path any user reaches. If you
 * are tempted to import this anywhere in `src/`, that is the wrong instinct —
 * call the real engine instead.
 */
async function consumeFifoForDemo(
  prisma: PrismaClient,
  shopId: string,
  prizeItemId: string,
  qty: number,
  type: "REDEEM" | "OPNAME_LOSS" | "DAMAGE",
  businessDate: Date,
  occurredAt: Date
): Promise<{ totalCogs: Prisma.Decimal; movementId: string } | null> {
  const batches = await prisma.prizeBatch.findMany({
    where: { shopId, prizeItemId, isVoid: false, qtyRemaining: { gt: 0 } },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  });

  const available = batches.reduce((sum, b) => sum + b.qtyRemaining, 0);
  if (available < qty) return null;

  const movement = await prisma.stockMovement.create({
    data: {
      shopId,
      prizeItemId,
      type,
      qtyDelta: -qty,
      businessDate,
      occurredAt,
      // Both shrinkage kinds carry a reason; a REDEEM does not need one. The
      // wording differs so the movement list reads as what actually happened.
      ...(type === "OPNAME_LOSS"
        ? { reason: `Demo shrinkage ${DEMO_TAG}` }
        : type === "DAMAGE"
          ? { reason: `Demo damaged stock ${DEMO_TAG}` }
          : {}),
    },
  });

  let remaining = qty;
  let totalCogs = new Prisma.Decimal(0);
  for (const batch of batches) {
    if (remaining === 0) break;
    const take = Math.min(remaining, batch.qtyRemaining);
    await prisma.prizeBatch.update({
      where: { id: batch.id },
      data: { qtyRemaining: { decrement: take } },
    });
    await prisma.stockConsumption.create({
      data: {
        movementId: movement.id,
        batchId: batch.id,
        qty: take,
        unitCogsAtConsumption: batch.unitCogs,
      },
    });
    totalCogs = totalCogs.add(batch.unitCogs.mul(take));
    remaining -= take;
  }

  return { totalCogs, movementId: movement.id };
}

/**
 * `--reset-demo`: delete every demo row, in foreign-key order.
 *
 * Scoped by DEMO- shop code and DEMO_TAG name, so real data is untouchable
 * from here. The order below is not cosmetic — a delete that runs before its
 * dependents will fail on a foreign key.
 */
export async function resetDemo(prisma: PrismaClient): Promise<void> {
  const shops = await prisma.shop.findMany({
    where: { code: { startsWith: DEMO_SHOP_PREFIX } },
    select: { id: true },
  });
  const shopIds = shops.map((s) => s.id);

  if (shopIds.length === 0) {
    console.log("  · no demo shops found; nothing to remove");
  }

  const users = await prisma.user.findMany({
    where: { displayName: { contains: DEMO_TAG } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  const customers = await prisma.customer.findMany({
    where: { name: { contains: DEMO_TAG } },
    select: { id: true },
  });
  const customerIds = customers.map((c) => c.id);

  // Matched on the SKU prefix as well as the name tag: `sku` is unique, so a
  // leftover demo prize would collide on the next --demo run and fail it.
  const prizes = await prisma.prizeItem.findMany({
    where: {
      OR: [{ name: { contains: DEMO_TAG } }, { sku: { startsWith: "DEMO-SKU-" } }],
    },
    select: { id: true },
  });
  const prizeIds = prizes.map((p) => p.id);

  const inShops = { shopId: { in: shopIds } };

  await prisma.stockConsumption.deleteMany({
    where: { movement: { OR: [inShops, { prizeItemId: { in: prizeIds } }] } },
  });
  await prisma.redemptionLine.deleteMany({
    where: {
      OR: [
        { redemption: { OR: [inShops, { customerId: { in: customerIds } }] } },
        { prizeItemId: { in: prizeIds } },
      ],
    },
  });
  await prisma.redemption.deleteMany({
    where: { OR: [inShops, { customerId: { in: customerIds } }] },
  });
  await prisma.stockMovement.deleteMany({
    where: { OR: [inShops, { prizeItemId: { in: prizeIds } }] },
  });
  await prisma.prizeBatch.deleteMany({
    where: { OR: [inShops, { prizeItemId: { in: prizeIds } }] },
  });
  await prisma.shopPrizeConfig.deleteMany({
    where: { OR: [inShops, { prizeItemId: { in: prizeIds } }] },
  });
  await prisma.prizeItem.deleteMany({ where: { id: { in: prizeIds } } });

  await prisma.ticketLedger.deleteMany({
    where: { OR: [inShops, { customerId: { in: customerIds } }] },
  });
  await prisma.marbleLedger.deleteMany({
    where: { OR: [inShops, { customerId: { in: customerIds } }] },
  });
  await prisma.sale.deleteMany({
    where: { OR: [inShops, { customerId: { in: customerIds } }] },
  });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });

  await prisma.expense.deleteMany({ where: inShops });
  await prisma.attendance.deleteMany({
    where: { OR: [inShops, { userId: { in: userIds } }] },
  });
  await prisma.shift.deleteMany({ where: inShops });
  await prisma.salePreset.deleteMany({ where: inShops });
  await prisma.workSession.deleteMany({
    where: { OR: [inShops, { userId: { in: userIds } }] },
  });
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userShop.deleteMany({
    where: { OR: [inShops, { userId: { in: userIds } }] },
  });

  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.account.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });

  console.log(
    `  ✔ demo data removed: ${shopIds.length} shops, ${userIds.length} users, ` +
      `${customerIds.length} customers, ${prizeIds.length} prizes`
  );
}
