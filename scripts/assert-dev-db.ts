/**
 * Refuses to proceed unless DATABASE_URL points at a disposable `_dev` or
 * `_test` database. Guards `db:reset` (`prisma migrate reset`), which drops
 * and recreates the whole database — nothing in Prisma itself stops that
 * from running against production if DATABASE_URL ever pointed there.
 *
 * Mirrors `assertDemoAllowed` in prisma/seed.ts — same check, same reasoning:
 * a database name is easy to get right by accident and catastrophic to get
 * wrong, so refuse rather than trust the caller.
 */
const url = process.env.DATABASE_URL ?? "";
const dbName = url.split("/").pop()?.split("?")[0] ?? "";

if (!/_dev$|_test$/.test(dbName)) {
  console.error(
    `\nRefusing to reset: DATABASE_URL points at "${dbName}", which is not a ` +
      `_dev or _test database.\n\n` +
      `db:reset drops and recreates the ENTIRE database. If this is really a ` +
      `disposable database, rename it (or its DATABASE_URL) to end in _dev or ` +
      `_test. If this is production, stop — production is reset by nothing; ` +
      `it only ever runs "prisma migrate deploy" (see docker-entrypoint.sh).\n`
  );
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  console.error(`\nRefusing to reset: NODE_ENV=production.\n`);
  process.exit(1);
}

console.log(`  ✔ DATABASE_URL points at "${dbName}" — safe to reset.`);
