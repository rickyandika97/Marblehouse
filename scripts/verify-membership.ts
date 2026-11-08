/** Run with: npx tsx --env-file=.env scripts/verify-membership.ts (local dev/test only). */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
} from "@zxing/library";
const { PNG } = createRequire(import.meta.url)("pngjs") as {
  PNG: {
    sync: {
      read(data: Buffer): { width: number; height: number; data: Buffer };
    };
  };
};
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/server/auth/password";
assert(
  /(?:_dev|_test)(?:\?|$)/.test(process.env.DATABASE_URL ?? ""),
  "Dev/test database required",
);
const db = new PrismaClient({ log: [] });
const base = process.env.MEMBERSHIP_VERIFY_URL ?? "http://localhost:5050";
assert(
  ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
  "Local server required",
);
const ids: string[] = [],
  customers: string[] = [];
class Browser {
  jar = new Map<string, string>();
  async call(
    path: string,
    body?: object,
    method?: string,
    extraHeaders: Record<string, string> = {},
  ) {
    const response = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]!;
      const index = pair.indexOf("=");
      this.jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
}
function downloadToken(qr: string) {
  const png = PNG.sync.read(Buffer.from(qr.split(",")[1]!, "base64"));
  const pixels = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = png.data[i * 4]!;
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, png.width, png.height)),
  );
  const url = new URL(
    new QRCodeReader()
      .decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]]))
      .getText(),
  );
  assert.equal(url.origin, "https://admin.redlight.click");
  assert.equal(url.pathname, "/membership/download");
  return url.hash.slice(1);
}
async function main() {
  try {
    const shop = await db.shop.findFirstOrThrow({
      where: { isActive: true, isHqPseudoShop: false },
    });
    const clients: Browser[] = [];
    for (const role of ["OWNER", "MANAGER", "STAFF"] as const) {
      const username = `qr-${randomUUID().slice(0, 8)}`,
        password = randomUUID();
      const user = await db.user.create({
        data: {
          username,
          displayUsername: username,
          email: `${username}@marblehouse.invalid`,
          name: username,
          displayName: username,
          isOwner: role === "OWNER",
          mustChangePassword: false,
        },
      });
      ids.push(user.id);
      await db.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: await hashPassword(password),
        },
      });
      if (role !== "OWNER")
        await db.userShop.create({
          data: { userId: user.id, shopId: shop.id, role },
        });
      const browser = new Browser();
      clients.push(browser);
      assert.equal(
        (await browser.call("/api/auth/login", { username, password })).status,
        200,
      );
      assert.equal(
        (await browser.call("/api/work-session", { shopId: shop.id })).status,
        200,
      );
      for (const page of ["/customers", "/customers/scan"]) {
        const result = await browser.call(page);
        assert.equal(result.status, 200);
        assert.ok((await result.text()).includes("Scan membership"));
      }
    }
    const [owner, manager, staff] = clients as [Browser, Browser, Browser];
    const made = await staff.call("/api/customers", {
      name: "QR Verification Fixture",
      phone: `0899${Date.now().toString().slice(-9)}`,
    });
    assert.equal(made.status, 200);
    const created = await made.json();
    customers.push(created.id);
    assert.ok(!JSON.stringify(created).includes("membershipToken"));
    assert.equal(
      (await staff.call(`/api/customers/${created.id}/membership`)).status,
      200,
      "registration can display card",
    );
    const row = await db.customer.findUniqueOrThrow({
      where: { id: created.id },
    });
    for (const browser of clients) {
      const found = await browser.call(`/api/customers?q=${row.id.slice(-8)}`);
      assert.equal(found.status, 200);
      const result = await found.json();
      assert.ok(result.customers.some((c: { id: string }) => c.id === row.id));
      assert.ok(!JSON.stringify(result).includes("membershipToken"));
      const page = await browser.call("/customers");
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes("Phone, name or member ID"));
      assert.ok(html.includes(row.id.slice(-8).toUpperCase()));
    }
    const code = `redlight:${row.membershipToken}`;
    const guest = new Browser();
    const tokens: string[] = [];
    const landing = await guest.call("/membership/download");
    assert.equal(landing.status, 200);
    assert.ok((await landing.text()).includes("Kartu membership Anda"));
    assert.equal((await guest.call(`/api/customers/${row.id}`)).status, 401);
    assert.equal(
      (
        await guest.call(
          `/api/customers/${row.id}/membership/download-link`,
          {},
        )
      ).status,
      401,
    );
    assert.equal(
      (await guest.call("/api/membership-download", {})).status,
      422,
    );
    // Unactivated first-card issuance is permitted without granting transaction access.
    const initialLink = await staff.call(
      `/api/customers/${row.id}/membership/download-link`,
      {},
    );
    assert.equal(initialLink.status, 200);
    const initialToken = downloadToken((await initialLink.json()).qr);
    tokens.push(initialToken);
    assert.equal(
      (await guest.call("/api/membership-download", { token: initialToken }))
        .status,
      200,
    );

    for (const browser of [manager, staff]) {
      assert.equal(
        (await browser.call("/customers/nonexistent-activation-fixture"))
          .status,
        404,
      );
      assert.equal(
        (await browser.call("/customers/nonexistent-activation-fixture/redeem"))
          .status,
        404,
      );
      const profile = await browser.call(`/api/customers/${row.id}`);
      assert.equal(profile.status, 200, "unactivated profiles remain visible");
      const data = await profile.json();
      assert.equal(data.membershipActivated, false);
      assert.ok(
        !("totalSpend" in data),
        "staff permissions do not expand to owner analytics",
      );
      assert.equal(
        (await browser.call(`/api/customers/${row.id}/ledger`)).status,
        200,
      );
      assert.equal(
        (await browser.call(`/api/customers/${row.id}/membership`)).status,
        200,
      );
      const page = await browser.call(`/customers/${row.id}`);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes("Redeem prizes"));
      const redeem = await browser.call(`/customers/${row.id}/redeem`);
      assert.equal(redeem.status, 200);
      assert.ok((await redeem.text()).includes("Activate membership"));
    }
    assert.equal(
      (await db.customer.findUniqueOrThrow({ where: { id: row.id } }))
        .membershipActivatedAt,
      null,
      "viewing/downloading a first card does not activate or verify it",
    );
    for (const [path, body] of [
      ["/api/marbles/deposit", { customerId: row.id, qty: 1 }],
      ["/api/marbles/withdraw", { customerId: row.id, qty: 1 }],
      [
        "/api/tickets/award",
        { customerId: row.id, qty: 1, ticketsCollected: true },
      ],
      [
        "/api/redemptions",
        { customerId: row.id, lines: [{ prizeItemId: "fake", qty: 1 }] },
      ],
    ] as const) {
      const denied = await staff.call(path, body);
      assert.equal(denied.status, 403);
      assert.equal(
        (await denied.json()).error.code,
        "MEMBERSHIP_ACTIVATION_REQUIRED",
      );
    }
    assert.equal(
      (await staff.call(`/api/customers/${row.id}/membership/activate`, {}))
        .status,
      422,
    );
    assert.equal(
      (
        await staff.call(`/api/customers/${row.id}/membership/activate`, {
          cardSaved: false,
        })
      ).status,
      422,
    );
    const activationKey = randomUUID();
    const activated = await staff.call(
      `/api/customers/${row.id}/membership/activate`,
      { cardSaved: true },
      "POST",
      { "Idempotency-Key": activationKey },
    );
    assert.equal(activated.status, 200);
    const activationReceipt = await activated.json();
    const replayActivation = await staff.call(
      `/api/customers/${row.id}/membership/activate`,
      { cardSaved: true },
      "POST",
      { "Idempotency-Key": activationKey },
    );
    assert.deepEqual(await replayActivation.json(), activationReceipt);
    assert.equal(
      await db.auditLog.count({
        where: { entityId: row.id, action: "ACTIVATE_MEMBERSHIP" },
      }),
      1,
    );
    assert.equal(
      await db.customerVerification.count({ where: { customerId: row.id } }),
      0,
    );
    assert.deepEqual(
      await (
        await staff.call(`/api/customers/${row.id}/membership/status`)
      ).json(),
      { activated: true, verified: false },
    );
    assert.equal(
      (
        await staff.call(`/api/customers/${row.id}/membership/activate`, {
          cardSaved: true,
        })
      ).status,
      409,
      "activation cannot reset a protected account",
    );
    assert.equal(
      (await guest.call("/api/membership-download", { token: initialToken }))
        .status,
      200,
      "the first download link survives activation for customer handoff",
    );

    for (const browser of [manager, staff]) {
      await db.customerVerification.deleteMany({
        where: { customerId: row.id },
      });
      assert.equal(
        (await browser.call(`/api/customers/${row.id}`)).status,
        403,
      );
      assert.equal(
        (await browser.call(`/api/customers/${row.id}/membership`)).status,
        403,
      );
      assert.equal(
        (
          await browser.call(
            `/api/customers/${row.id}/membership/download-link`,
            {},
          )
        ).status,
        403,
      );
      const locked = await browser.call(`/customers/${row.id}`);
      assert.equal(locked.status, 200);
      assert.ok((await locked.text()).includes("Verify membership"));
      const redeemLocked = await browser.call(`/customers/${row.id}/redeem`);
      assert.equal(redeemLocked.status, 200);
      assert.ok((await redeemLocked.text()).includes("Verify membership"));
      assert.equal(
        (
          await browser.call("/api/marbles/withdraw", {
            customerId: row.id,
            qty: 1,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await browser.call("/api/customers/scan", {
            code,
            customerId: "wrong",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await browser.call("/api/customers/scan", {
            code,
            customerId: row.id,
          })
        ).status,
        200,
      );
      assert.equal(
        (await browser.call(`/api/customers/${row.id}`)).status,
        200,
      );
      const cardResponse = await browser.call(
        `/api/customers/${row.id}/membership`,
      );
      assert.equal(cardResponse.status, 200);
      assert.ok(
        cardResponse.headers.get("cache-control")?.includes("no-store"),
      );
      const card = await cardResponse.json();
      assert.ok(card.qr.startsWith("data:image/png;base64,"));
      const png = PNG.sync.read(Buffer.from(card.qr.split(",")[1], "base64"));
      const pixels = new Uint8ClampedArray(png.width * png.height);
      for (let i = 0; i < pixels.length; i++) pixels[i] = png.data[i * 4]!;
      const bitmap = new BinaryBitmap(
        new HybridBinarizer(
          new RGBLuminanceSource(pixels, png.width, png.height),
        ),
      );
      assert.equal(
        new QRCodeReader().decode(bitmap).getText(),
        code,
        "Generated QR round-trips to the exact credential",
      );
      assert.equal(card.canReplace, false);
      assert.equal(card.membershipActivated, true);
      const resetAttempt = await browser.call(
        `/api/customers/${row.id}`,
        { membershipActivated: false, membershipActivatedAt: null },
        "PATCH",
      );
      assert.equal(resetAttempt.status, 200);
      assert.equal(
        (await resetAttempt.json()).membershipActivated,
        true,
        "profile edits cannot reset activation",
      );
      const key = randomUUID();
      const linkResponse = await browser.call(
        `/api/customers/${row.id}/membership/download-link`,
        {},
        "POST",
        { "Idempotency-Key": key },
      );
      assert.equal(linkResponse.status, 200);
      assert.ok(
        linkResponse.headers.get("cache-control")?.includes("no-store"),
      );
      const link = await linkResponse.json();
      const token = downloadToken(link.qr);
      tokens.push(token);
      const replay = await browser.call(
        `/api/customers/${row.id}/membership/download-link`,
        {},
        "POST",
        { "Idempotency-Key": key },
      );
      assert.deepEqual(await replay.json(), link);
      const stored = await db.idempotencyKey.findUniqueOrThrow({
        where: { key },
      });
      assert.ok(!JSON.stringify(stored.responseJson).includes(token));
      assert.ok(
        !JSON.stringify(stored.responseJson).includes(row.membershipToken),
      );
      for (let retry = 0; retry < 2; retry++) {
        const publicCard = await guest.call("/api/membership-download", {
          token,
        });
        assert.equal(publicCard.status, 200);
        assert.ok(
          publicCard.headers.get("cache-control")?.includes("no-store"),
        );
        const data = await publicCard.json();
        assert.deepEqual(Object.keys(data).sort(), [
          "memberNumber",
          "name",
          "qr",
        ]);
        assert.equal(data.qr, card.qr);
      }
      assert.equal(
        (
          await guest.call("/api/membership-download", {
            token: token.slice(0, -8) + "aaaaaaaa",
          })
        ).status,
        404,
      );
      await db.customerVerification.updateMany({
        where: { customerId: row.id },
        data: { expiresAt: new Date(0) },
      });
      assert.equal(
        (
          await browser.call(
            `/api/customers/${row.id}/membership/download-link`,
            {},
            "POST",
            { "Idempotency-Key": key },
          )
        ).status,
        403,
        "replay does not bypass expired staff verification",
      );
      assert.equal(
        (await guest.call("/api/membership-download", { token })).status,
        200,
        "issued customer link remains valid for ten minutes",
      );
      assert.equal(
        (
          await browser.call("/api/customers/scan", {
            code,
            customerId: row.id,
          })
        ).status,
        200,
      );

      const detail = await browser.call(`/customers/${row.id}`);
      assert.equal(detail.status, 200);
      assert.ok((await detail.text()).includes("Membership card"));
      const redeem = await browser.call(`/customers/${row.id}/redeem`);
      assert.equal(redeem.status, 200);
      assert.ok((await redeem.text()).includes("Redeem prizes"));
      assert.equal(
        (
          await browser.call(`/api/customers/${row.id}/membership`, {
            reason: "Lost card",
          })
        ).status,
        403,
      );
    }
    assert.equal((await owner.call(`/customers/${row.id}`)).status, 200);
    assert.equal(
      (
        await owner.call(`/api/customers/${row.id}/membership`, {
          reason: "Verified fixture replacement",
        })
      ).status,
      200,
    );
    assert.equal(
      (await staff.call("/api/customers/scan", { code })).status,
      404,
    );
    assert.equal((await staff.call(`/api/customers/${row.id}`)).status, 403);
    for (const token of tokens)
      assert.equal(
        (await guest.call("/api/membership-download", { token })).status,
        404,
        "lost-card replacement invalidates all earlier download links",
      );
    console.log(
      "PASS: rendered pages for owner, manager, staff; registration card; direct URL/API protection; wrong card; matching scan; card privacy; owner replacement; old QR invalidation; public download page and capability API; issuance permission/replay; generated link QR; expiry gates; replacement invalidation; unactivated profiles; activation confirmation/idempotency; mandatory post-activation scan",
    );
  } finally {
    await db.customerVerification.deleteMany({
      where: { userId: { in: ids } },
    });
    await db.idempotencyKey.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.customer.deleteMany({ where: { id: { in: customers } } });
    await db.workSession.deleteMany({ where: { userId: { in: ids } } });
    await db.userShop.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
