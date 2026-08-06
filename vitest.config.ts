import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit/integration tests (PRD §15).
 *
 * These run against the REAL development database, not a mock. FIFO is
 * `ORDER BY receivedAt` plus conditional updates that PostgreSQL arbitrates —
 * a mocked Prisma client would test the mock, not the invariant that matters.
 * Every test wraps itself in a transaction that is always rolled back, so a
 * full run leaves no rows behind. See `src/server/services/__tests__/helpers.ts`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suite shares one database. Parallel files would interleave their
    // transactions and make advisory-lock and concurrency tests flap.
    fileParallelism: false,
    testTimeout: 30_000,
    setupFiles: ["src/server/services/__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
