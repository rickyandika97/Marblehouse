/** Run on the server: npm run technician:setup -- admin [--generate] */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { provisionTechnician } from "../src/server/services/technician-setup";
import { prisma } from "../src/lib/prisma";

async function main() {
  const username = process.argv[2] ?? "admin";
  const generate = process.argv.includes("--generate");
  let password: string;
  if (generate) password = randomBytes(24).toString("base64url");
  else {
    if (!process.stdin.isTTY) throw new Error("Run in a terminal to enter a password, or use --generate.");
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const input = createInterface({ input: process.stdin, output: muted, terminal: true });
    try {
      process.stdout.write("Technician password (hidden): ");
      password = await input.question("");
      process.stdout.write("\nConfirm password (hidden): ");
      if (password !== await input.question("")) throw new Error("Passwords do not match.");
      process.stdout.write("\n");
    } finally { input.close(); }
  }
  // Read first, so a missing configuration cannot create an unusable account.
  const envPath = join(process.cwd(), ".env");
  const env = await readFile(envPath, "utf8");
  const user = await provisionTechnician(username, password);
  const nextEnv = env.replace(/^TECHNICIAN_USER_ID=.*\r?\n?/gm, "").trimEnd() + `\nTECHNICIAN_USER_ID=${user.id}\n`;
  await writeFile(envPath, nextEnv, { mode: 0o600 });
  await chmod(envPath, 0o600);
  if (generate) {
    const folder = await mkdtemp(join(tmpdir(), "marblehouse-technician-"));
    const file = join(folder, "credentials.txt");
    await writeFile(file, `Username: ${username}\nPassword: ${password}\n`, { mode: 0o600 });
    console.log(`Credentials saved privately to ${file}`);
  }
  console.log("Technician account configured. Restart the app to apply the configuration.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Setup failed."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
