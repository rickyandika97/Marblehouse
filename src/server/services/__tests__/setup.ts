/**
 * Vitest global setup. Loads `.env` so DATABASE_URL is present, exactly as
 * `tsx --env-file=.env` does for the scripts.
 *
 * Guard: refuse to run against anything that is not obviously a development
 * database. The suite writes and rolls back, but a bug in a rollback would
 * otherwise land on real data.
 */
import { loadEnvFile } from "node:process";

loadEnvFile(new URL("../../../../.env", import.meta.url).pathname);

const url = process.env.DATABASE_URL ?? "";

if (!url) {
  throw new Error("DATABASE_URL is not set — cannot run the test suite.");
}

if (!/_dev|_test/.test(url)) {
  throw new Error(
    `Refusing to run tests against ${url.replace(/:[^:@]*@/, ":***@")}. ` +
      "The suite expects a database whose name contains _dev or _test."
  );
}
