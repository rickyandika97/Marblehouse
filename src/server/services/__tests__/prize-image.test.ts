/**
 * Prize catalog images (PRD §4.8, §8.6; BUILD-LOG D-118).
 *
 * These run sharp for real against a generated image and write real files
 * under the data root, cleaning up in `afterAll`. Mocking sharp would prove
 * nothing about the two things most likely to break: that the stored file is
 * actually a square JPEG, and that EXIF is gone.
 *
 * What is worth proving here rather than assuming:
 *
 *  - **The superseded file is DELETED on replace.** This is the whole reason
 *    prize images need no retention job. If it regresses, the data directory
 *    grows without bound and every backup silently carries the dead weight —
 *    a failure nobody notices until the disk fills.
 *  - **EXIF is stripped.** A phone photo of a prize carries the GPS
 *    coordinates of the shop. §14 is much easier to keep if we never store it.
 *  - **The output is square**, because §8.6's card grid depends on a
 *    predictable aspect ratio.
 *  - **Traversal is refused** by the resolver the image route uses.
 *  - **Clearing is idempotent** — a double-tap on shop wifi must not 404.
 */
import { describe, expect, it, afterAll, afterEach } from "vitest";
import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { prisma, uniq, makeActorWithUser } from "./helpers";
import {
  deletePrizeImage,
  resolvePrizeImagePath,
  storePrizeImage,
} from "../prize-image";
import { clearPrizeImage, getPrizeImagePath, setPrizeImage } from "../prizes";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

const TEST_SKU_PREFIX = "ZIMG";

const written: string[] = [];
const prizeIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: prizeIds } }, { userId: { in: userIds } }] },
  });
  await prisma.prizeItem.deleteMany({ where: { id: { in: prizeIds } } });
  await prisma.prizeItem.deleteMany({
    where: { sku: { startsWith: TEST_SKU_PREFIX } },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  prizeIds.length = 0;
  userIds.length = 0;
});

afterAll(async () => {
  for (const p of written) await deletePrizeImage(p).catch(() => {});
  await prisma.$disconnect();
});

/** A plain image with no EXIF. */
async function image(width = 800, height = 600): Promise<ArrayBuffer> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: "#b5744a" },
  })
    .jpeg()
    .toBuffer();
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** An image carrying EXIF, the shape a phone upload really has. */
async function imageWithExif(): Promise<ArrayBuffer> {
  const buf = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#4a7fb5" },
  })
    .withExif({ IFD0: { Copyright: "MARBLEHOUSE-TEST", Software: "test" } })
    .jpeg()
    .toBuffer();
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

async function store(bytes: ArrayBuffer) {
  const result = await storePrizeImage(bytes);
  written.push(result.relativePath);
  return result;
}

async function makeUser(role: "OWNER" | "MANAGER" | "STAFF"): Promise<Actor> {
  const actor = await makeActorWithUser(prisma as unknown as Prisma.TransactionClient, {
    role,
    businessDate: new Date("2026-08-19T00:00:00.000Z"),
  });
  userIds.push(actor.userId);
  return actor;
}

async function makePrize() {
  const prize = await prisma.prizeItem.create({
    data: {
      sku: `${TEST_SKU_PREFIX}-${uniq()}`,
      name: `Image Prize ${uniq()}`,
      ticketCost: 100,
    },
  });
  prizeIds.push(prize.id);
  return prize;
}

describe("storePrizeImage", () => {
  it("writes a square JPEG at the catalog size", async () => {
    const { absolutePath } = await store(await image(800, 600));
    const meta = await sharp(await readFile(absolutePath)).metadata();

    expect(meta.format).toBe("jpeg");
    // §8.6's grid depends on this: a mixed-aspect grid reads as broken.
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(600);
  });

  /**
   * The output is square for EVERY source shape.
   *
   * This caught a real defect (D-118). The obvious implementation —
   * `resize({ width: 600, height: 600, fit: "cover", withoutEnlargement: true })`
   * — clamps each axis to the source independently, so 1600x400 came out
   * 600x400 and 300x900 came out 300x600. §8.6's card grid depends on a
   * predictable aspect ratio, so a ragged grid would have shipped.
   */
  for (const [w, h] of [
    [1600, 400], // wide and short — the case that failed
    [300, 900], // tall and narrow — also failed
    [200, 200], // already square, below the output size
    [4000, 3000], // a real phone photo
    [50, 4000], // absurd, but must not crash or stretch
  ] as const) {
    it(`is square for a ${w}x${h} source`, async () => {
      const { absolutePath } = await store(await image(w, h));
      const meta = await sharp(await readFile(absolutePath)).metadata();
      expect(meta.width).toBe(meta.height);
      expect(meta.width!).toBeLessThanOrEqual(600);
    });
  }

  it("does not enlarge a small source", async () => {
    const { absolutePath } = await store(await image(200, 200));
    const meta = await sharp(await readFile(absolutePath)).metadata();
    // withoutEnlargement: upscaling a 200px photo to 600 just makes it blurry
    // and triples the file size for nothing.
    expect(meta.width).toBe(200);
  });

  it("strips EXIF, so a shop's GPS never reaches the disk", async () => {
    const { absolutePath } = await store(await imageWithExif());
    const meta = await sharp(await readFile(absolutePath)).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("stores under prizes/YYYY/MM/DD, relative to the data root", async () => {
    const { relativePath } = await store(await image());
    expect(relativePath).toMatch(/^prizes[/\\]\d{4}[/\\]\d{2}[/\\]\d{2}[/\\].+\.jpg$/);
  });

  it("gives every upload its own name, so two never collide", async () => {
    const a = await store(await image());
    const b = await store(await image());
    expect(a.relativePath).not.toBe(b.relativePath);
  });

  it("refuses an empty upload", async () => {
    await expect(storePrizeImage(new ArrayBuffer(0))).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("refuses a file that is not an image", async () => {
    const notAnImage = new TextEncoder().encode("this is a PDF, honestly");
    await expect(
      storePrizeImage(notAnImage.buffer as ArrayBuffer),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("resolvePrizeImagePath", () => {
  it("refuses traversal out of the data root", () => {
    expect(() => resolvePrizeImagePath("../../etc/passwd")).toThrow(AppError);
    expect(() => resolvePrizeImagePath("prizes/../../../secrets")).toThrow(
      AppError,
    );
  });

  it("accepts a path the store actually produced", async () => {
    const { relativePath, absolutePath } = await store(await image());
    expect(resolvePrizeImagePath(relativePath)).toBe(absolutePath);
  });
});

describe("setPrizeImage / clearPrizeImage", () => {
  it("attaches an image and records it on the prize", async () => {
    const owner = await makeUser("OWNER");
    const prize = await makePrize();
    const { relativePath } = await store(await image());

    const dto = await setPrizeImage(owner, prize.id, relativePath);
    expect(dto.imagePath).toBe(relativePath);
  });

  it("DELETES the superseded file when an image is replaced", async () => {
    // The invariant that keeps the data directory from growing without bound,
    // and the reason prize images need no retention job.
    const owner = await makeUser("OWNER");
    const prize = await makePrize();

    const first = await store(await image());
    await setPrizeImage(owner, prize.id, first.relativePath);

    const second = await store(await image());
    await setPrizeImage(owner, prize.id, second.relativePath);

    await expect(stat(first.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The replacement is still there — deleting the wrong one would be worse.
    await expect(stat(second.absolutePath)).resolves.toBeTruthy();
  });

  it("keeps the file when the same path is set twice", async () => {
    const owner = await makeUser("OWNER");
    const prize = await makePrize();
    const { relativePath, absolutePath } = await store(await image());

    await setPrizeImage(owner, prize.id, relativePath);
    await setPrizeImage(owner, prize.id, relativePath);

    // A no-op replace must not delete the image it just "set".
    await expect(stat(absolutePath)).resolves.toBeTruthy();
  });

  it("removes the image and deletes the file", async () => {
    const owner = await makeUser("OWNER");
    const prize = await makePrize();
    const { relativePath, absolutePath } = await store(await image());
    await setPrizeImage(owner, prize.id, relativePath);

    const dto = await clearPrizeImage(owner, prize.id);
    expect(dto.imagePath).toBeNull();
    await expect(stat(absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clearing a prize that has no image is a no-op, not an error", async () => {
    // A double-tap on slow shop wifi must not surface a failure for something
    // that is already true.
    const owner = await makeUser("OWNER");
    const prize = await makePrize();

    const dto = await clearPrizeImage(owner, prize.id);
    expect(dto.imagePath).toBeNull();
  });

  it("audits an attach with the old and new path", async () => {
    const owner = await makeUser("OWNER");
    const prize = await makePrize();
    const { relativePath } = await store(await image());

    await setPrizeImage(owner, prize.id, relativePath);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: prize.id, action: "PRIZE_IMAGE_SET" },
    });
    expect(audit?.after).toMatchObject({ imagePath: relativePath });
  });

  it("does NOT audit a removal that removed nothing", async () => {
    const owner = await makeUser("OWNER");
    const prize = await makePrize();

    await clearPrizeImage(owner, prize.id);

    const count = await prisma.auditLog.count({
      where: { entityId: prize.id, action: "PRIZE_IMAGE_CLEAR" },
    });
    expect(count).toBe(0);
  });

  it("404s on a prize that no longer exists", async () => {
    const owner = await makeUser("OWNER");
    await expect(
      setPrizeImage(owner, "no-such-prize", "prizes/2026/01/01/x.jpg"),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("getPrizeImagePath — what the image route reads", () => {
  it("returns the stored path for any signed-in role", async () => {
    // Staff need prize images to redeem (§8.6), so this is deliberately not
    // gated beyond having a session.
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF");
    const prize = await makePrize();
    const { relativePath } = await store(await image());
    await setPrizeImage(owner, prize.id, relativePath);

    await expect(getPrizeImagePath(staff, prize.id)).resolves.toBe(relativePath);
  });

  it("404s when the prize has no image", async () => {
    const staff = await makeUser("STAFF");
    const prize = await makePrize();
    await expect(getPrizeImagePath(staff, prize.id)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
