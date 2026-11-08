import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  RGBLuminanceSource,
  QRCodeReader,
} from "@zxing/library";
import { prisma, withRollback, makeActorWithUser, uniq } from "./helpers";
import {
  createMembershipDownload,
  presentMembershipDownload,
  readMembershipDownload,
  membershipDownloadOrigin,
  DOWNLOAD_TTL_MS,
} from "../membership-download";
import { scanMembership, replaceMembershipCard } from "../membership";
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  PNG: {
    sync: {
      read(data: Buffer): { width: number; height: number; data: Buffer };
    };
  };
};
function linkToken(qr: string): string {
  const png = PNG.sync.read(Buffer.from(qr.split(",")[1]!, "base64"));
  const pixels = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = png.data[i * 4]!;
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, png.width, png.height)),
  );
  // This is a generated, flat PNG: validate its encoded URL without camera perspective detection.
  const url = new URL(
    new QRCodeReader()
      .decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]]))
      .getText(),
  );
  expect(url.origin).toBe("https://admin.redlight.click");
  expect(url.pathname).toBe("/membership/download");
  return url.hash.slice(1);
}
function configure() {
  vi.stubEnv("MEMBERSHIP_DOWNLOAD_ORIGIN", "https://admin.redlight.click");
  vi.stubEnv("SESSION_SECRET", "download-test-secret-never-used-in-production");
}
async function customer(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const suffix = uniq();
  return tx.customer.create({
    data: { name: "Kevin", phoneRaw: suffix, phoneNormalized: suffix },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => prisma.$disconnect());

describe("temporary membership downloads", () => {
  for (const role of ["STAFF", "MANAGER"] as const) {
    test(`${role} needs existing verification; same grant supports retry without another audit`, () =>
      withRollback(async (tx) => {
        configure();
        const actor = await makeActorWithUser(tx, { role });
        const a = await customer(tx),
          b = await customer(tx);
        await expect(
          createMembershipDownload(actor, a.id, tx),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
        await scanMembership(
          actor,
          { code: `redlight:${a.membershipToken}` },
          tx,
        );
        const grant = await createMembershipDownload(actor, a.id, tx);
        expect(JSON.stringify(grant)).not.toContain(a.membershipToken);
        expect(grant.e).toBeLessThanOrEqual(Date.now() + DOWNLOAD_TTL_MS);
        const first = await presentMembershipDownload(actor, grant, tx);
        const again = await presentMembershipDownload(actor, grant, tx);
        expect(first).toEqual(again);
        const token = linkToken(first.qr);
        expect(token).not.toContain(a.membershipToken);
        const card = await readMembershipDownload(token, tx);
        expect(card.name).toBe(a.name);
        expect(Object.keys(card).sort()).toEqual([
          "memberNumber",
          "name",
          "qr",
        ]);
        expect(await readMembershipDownload(token, tx)).toEqual(card);
        expect(
          await tx.auditLog.count({
            where: { entityId: a.id, action: "CREATE_MEMBERSHIP_DOWNLOAD" },
          }),
        ).toBe(1);
        expect(
          await tx.customerVerification.count({ where: { customerId: b.id } }),
        ).toBe(0);
        await expect(
          createMembershipDownload(actor, b.id, tx),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
        await tx.customerVerification.update({
          where: { sessionId: actor.sessionId },
          data: { expiresAt: new Date(0) },
        });
        await expect(
          createMembershipDownload(actor, a.id, tx),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
        await expect(
          presentMembershipDownload(actor, grant, tx),
        ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
        // A valid issued customer link lasts ten minutes independently of the five-minute staff grant.
        expect((await readMembershipDownload(token, tx)).name).toBe(a.name);
      }));
  }
  test("owner can issue without scan; signature, expiry, rotation and current card version are enforced", () =>
    withRollback(async (tx) => {
      configure();
      const owner = await makeActorWithUser(tx, { role: "OWNER" });
      const a = await customer(tx);
      const grant = await createMembershipDownload(owner, a.id, tx);
      const token = linkToken(
        (await presentMembershipDownload(owner, grant, tx)).qr,
      );
      await expect(
        readMembershipDownload(token.slice(0, -8) + "aaaaaaaa", tx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const payload = JSON.parse(
        Buffer.from(token.split(".")[0]!, "base64url").toString(),
      );
      payload.c = "different-customer";
      await expect(
        readMembershipDownload(
          Buffer.from(JSON.stringify(payload)).toString("base64url") +
            "." +
            token.split(".")[1],
          tx,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      vi.spyOn(Date, "now").mockReturnValue(grant.e);
      await expect(readMembershipDownload(token, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      vi.restoreAllMocks();
      vi.stubEnv(
        "SESSION_SECRET",
        "a-different-server-signing-secret-for-testing",
      );
      await expect(readMembershipDownload(token, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      configure();
      await replaceMembershipCard(
        owner,
        a.id,
        { reason: "Verified lost membership card" },
        tx,
      );
      await expect(readMembershipDownload(token, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        presentMembershipDownload(owner, grant, tx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        JSON.stringify(
          await tx.auditLog.findMany({ where: { entityId: a.id } }),
        ),
      ).not.toContain(token);
    }));
  test("inactive/merged customers and deactivated issuers cannot serve cards", () =>
    withRollback(async (tx) => {
      configure();
      const owner = await makeActorWithUser(tx, { role: "OWNER" });
      const a = await customer(tx);
      const token = linkToken(
        (
          await presentMembershipDownload(
            owner,
            await createMembershipDownload(owner, a.id, tx),
            tx,
          )
        ).qr,
      );
      await tx.customer.update({
        where: { id: a.id },
        data: { isActive: false },
      });
      await expect(readMembershipDownload(token, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await tx.customer.update({
        where: { id: a.id },
        data: { isActive: true, mergedIntoId: "winner" },
      });
      await expect(readMembershipDownload(token, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await tx.customer.update({
        where: { id: a.id },
        data: { mergedIntoId: null },
      });
      await tx.user.update({
        where: { id: owner.userId },
        data: { banned: true },
      });
      await expect(readMembershipDownload(token, tx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }));
  test("uses configured HTTPS origin, never a request host or localhost login URL", () => {
    configure();
    expect(membershipDownloadOrigin()).toBe("https://admin.redlight.click");
    for (const origin of [
      "http://localhost:5050",
      "https://admin.redlight.click/login",
      "https://user:pass@example.com",
      "https://example.com?token=bad",
    ]) {
      vi.stubEnv("MEMBERSHIP_DOWNLOAD_ORIGIN", origin);
      expect(() => membershipDownloadOrigin()).toThrow();
    }
    vi.stubEnv("MEMBERSHIP_DOWNLOAD_ORIGIN", "");
    vi.stubEnv("APP_URL", "https://admin.redlight.click");
    expect(membershipDownloadOrigin()).toBe("https://admin.redlight.click");
  });
});
