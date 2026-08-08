/**
 * Idempotent seed — safe to run on every container boot.
 *
 * Creates exactly ONE shop plus the HQ pseudo-shop. Further branches are
 * created through the UI (PRD §5.6). Nothing here may assume a branch count.
 */
import { PrismaClient } from "@prisma/client";
import { auth } from "../src/server/auth/auth";
import { seedDemo, resetDemo } from "./demo";

const prisma = new PrismaClient();

const EXPENSE_CATEGORIES = [
  "Electricity",
  "Rent",
  "Water",
  "Internet",
  "Salary",
  "Machine Maintenance",
  "Supplies",
  "Marketing",
  "Transport",
  "Other",
];

// Amounts only. No marble counts — a sale records money (PRD §4.3).
const DEFAULT_PRESETS = [
  { label: "Rp 20.000", amount: 20000, sortOrder: 1 },
  { label: "Rp 50.000", amount: 50000, sortOrder: 2 },
  { label: "Rp 100.000", amount: 100000, sortOrder: 3 },
  { label: "Rp 200.000", amount: 200000, sortOrder: 4 },
  { label: "Rp 500.000", amount: 500000, sortOrder: 5 },
];

const DEFAULT_SHIFTS = [
  { name: "Morning", startTime: "10:00:00", endTime: "18:00:00" },
  { name: "Evening", startTime: "18:00:00", endTime: "23:00:00" },
];

/** Prisma maps @db.Time to a Date; only the time-of-day portion is stored. */
function timeOfDay(hhmmss: string): Date {
  return new Date(`1970-01-01T${hhmmss}.000Z`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in .env — there is deliberately no default password.`
    );
  }
  return value;
}

/**
 * Demo data must never reach a production database (§10: "you do not want it
 * drifting into production"). A flag is easy to type by accident on the wrong
 * shell, so this refuses outright unless the database name marks it as
 * disposable — the same guard the test suite uses (D-26).
 */
function assertDemoAllowed(flag: string): void {
  const url = process.env.DATABASE_URL ?? "";
  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_dev$|_test$/.test(dbName)) {
    throw new Error(
      `Refusing to run ${flag}: DATABASE_URL points at "${dbName}", which is ` +
        `not a _dev or _test database. Demo data must never enter production.`
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Refusing to run ${flag} with NODE_ENV=production.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantsDemo = args.includes("--demo");
  const wantsResetDemo = args.includes("--reset-demo");

  if (wantsDemo && wantsResetDemo) {
    throw new Error("Pass either --demo or --reset-demo, not both.");
  }

  if (wantsResetDemo) {
    assertDemoAllowed("--reset-demo");
    console.log("\n  Removing demo data…");
    await resetDemo(prisma);
    return;
  }

  const ownerUsername = requireEnv("SEED_OWNER_USERNAME").toLowerCase();
  const ownerPassword = requireEnv("SEED_OWNER_PASSWORD");
  const shopName = process.env.SEED_SHOP_NAME?.trim() || "Branch 1";
  const timezone = process.env.TZ || "Asia/Jakarta";
  const ticketAwardReasonThreshold = Number(
    process.env.TICKET_AWARD_REASON_THRESHOLD ?? 500
  );

  if (ownerPassword.length < 8) {
    throw new Error("SEED_OWNER_PASSWORD must be at least 8 characters.");
  }
  if (
    !Number.isInteger(ticketAwardReasonThreshold) ||
    ticketAwardReasonThreshold < 1
  ) {
    throw new Error(
      "TICKET_AWARD_REASON_THRESHOLD must be a positive whole number."
    );
  }

  // ── Shops ──────────────────────────────────────────────────────────
  const shop = await prisma.shop.upsert({
    where: { code: "BR-1" },
    update: {},
    create: { code: "BR-1", name: shopName, timezone },
  });

  await prisma.shop.upsert({
    where: { code: "HQ" },
    update: {},
    create: {
      code: "HQ",
      name: "HQ / Unallocated",
      timezone,
      isHqPseudoShop: true, // expense-only, accepts no sales
    },
  });

  // ── Owner ──────────────────────────────────────────────────────────
  const existingOwner = await prisma.user.findUnique({
    where: { username: ownerUsername },
  });

  if (!existingOwner) {
    // Created through Better Auth so the credential account and its argon2id
    // hash exist. A directly-inserted user row would have no password.
    //
    // The email is SYNTHETIC and must stay that way: this business collects no
    // email addresses (§5.4). `.invalid` is reserved by RFC 2606 and can never
    // resolve, so a mistakenly-enabled email path fails hard instead of
    // mailing a real stranger. Do not wire up real email here.
    await auth.api.createUser({
      body: {
        email: `${ownerUsername}@marblehouse.invalid`,
        password: ownerPassword,
        name: "Owner",
        data: {
          username: ownerUsername,
          displayUsername: ownerUsername,
          displayName: "Owner",
          role: "OWNER",
          defaultShopId: shop.id,
          mustChangePassword: true,
        },
      },
    });
    console.log(`  ✔ owner account "${ownerUsername}" created`);
  } else {
    console.log(`  · owner account "${ownerUsername}" already exists, left alone`);
  }

  // ── Global settings ────────────────────────────────────────────────
  // The business-day boundary is GLOBAL, not per-shop (§4.2, C-1, D-18).
  // `update: {}` so a reseed never overwrites an hour the owner has changed —
  // changing it does not restamp existing rows, so a silent reset here would
  // put a seam in the data that nobody asked for.
  await prisma.appSetting.upsert({
    where: { key: "businessDayStartHour" },
    update: {},
    create: { key: "businessDayStartHour", value: 4 },
  });
  console.log("  ✔ business day starts at 04:00 (global)");

  // Phase 3 anti-fraud control (§4.6). Like the business-day boundary, a
  // reseed must never overwrite an owner-tuned value.
  await prisma.appSetting.upsert({
    where: { key: "ticketAwardReasonThreshold" },
    update: {},
    create: {
      key: "ticketAwardReasonThreshold",
      value: ticketAwardReasonThreshold,
    },
  });
  console.log("  ✔ ticket-award reason threshold configured (global)");

  // ── Sale presets for the first shop ────────────────────────────────
  const presetCount = await prisma.salePreset.count({ where: { shopId: shop.id } });
  if (presetCount === 0) {
    await prisma.salePreset.createMany({
      data: DEFAULT_PRESETS.map((p) => ({ ...p, shopId: shop.id })),
    });
    console.log(`  ✔ ${DEFAULT_PRESETS.length} sale presets created`);
  }

  // ── Shifts ─────────────────────────────────────────────────────────
  const shiftCount = await prisma.shift.count({ where: { shopId: shop.id } });
  if (shiftCount === 0) {
    await prisma.shift.createMany({
      data: DEFAULT_SHIFTS.map((s) => ({
        shopId: shop.id,
        name: s.name,
        startTime: timeOfDay(s.startTime),
        endTime: timeOfDay(s.endTime),
      })),
    });
    console.log(`  ✔ ${DEFAULT_SHIFTS.length} shifts created`);
  }

  // ── Expense categories ─────────────────────────────────────────────
  for (const [i, name] of EXPENSE_CATEGORIES.entries()) {
    await prisma.expenseCategory.upsert({
      where: { name },
      update: {},
      create: { name, sortOrder: i },
    });
  }

  console.log(`\n  Seed complete. Log in as "${ownerUsername}".`);
  console.log(`  You will be asked to change the password on first login.\n`);

  // Demo generation runs AFTER the base seed, because it depends on the
  // expense categories and the global settings created above.
  if (wantsDemo) {
    assertDemoAllowed("--demo");
    await seedDemo(prisma);
  }
}

main()
  .catch((e) => {
    console.error("\n  Seed failed:\n", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
