/**
 * `reportableShops` — the shop list behind the report and dashboard filters
 * (D-177).
 *
 * This exists because of a real defect: the filter bar was populated from
 * `selectableShops`, which asks "which shops are you assigned to?", while the
 * report data behind it is gated by `resolveScope(…, { requireManagerAt: true })`,
 * which asks "which shops do you MANAGE?". A user who is MANAGER at one branch
 * and STAFF at another was therefore offered a branch whose numbers the server
 * then refused — the picker said one shop, the figures were another's.
 *
 * The property under test is that the two questions now agree. That is why the
 * mixed-role actor is the central fixture here rather than an edge case: an
 * actor who is MANAGER everywhere passes under either implementation, so a test
 * built only on one would have stayed green throughout the bug (D-34).
 *
 * Filtering happens in SQL (§5.6), so these run against real rows rather than a
 * fabricated actor — a hand-built `shopRoles` map would test nothing about the
 * `where` clause that actually does the work.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, uniq, makeActor } from "./helpers";
import { reportableShops, selectableShops } from "@/server/auth/context";

let tag: string;
let managed: string;
let staffed: string;
let hq: string;
let retired: string;
let userId: string;

beforeEach(async () => {
  tag = uniq();

  const mkShop = async (
    code: string,
    name: string,
    extra: { isHqPseudoShop?: boolean; isActive?: boolean } = {}
  ) =>
    (
      await prisma.shop.create({
        data: {
          code: `${code}-${tag}`,
          name: `${name} ${tag}`,
          timezone: "Asia/Jakarta",
          ...extra,
        },
      })
    ).id;

  // Names are prefixed so the alphabetical ordering inside one fixture is
  // predictable, and suffixed with `tag` so parallel runs cannot collide.
  managed = await mkShop("RS-M", "A Managed");
  staffed = await mkShop("RS-S", "B Staffed");
  hq = await mkShop("RS-HQ", "C Head office", { isHqPseudoShop: true });
  retired = await mkShop("RS-X", "D Retired", { isActive: false });

  const user = await prisma.user.create({
    data: {
      email: `rs-${tag}@marblehouse.invalid`,
      name: `RS ${tag}`,
      username: `rs-${tag}`,
      displayName: `RS ${tag}`,
    },
  });
  userId = user.id;

  // The mixed-role account: MANAGER at one branch, STAFF at another. This is
  // the D-138 shape, one level up in the UI.
  await prisma.userShop.createMany({
    data: [
      { userId, shopId: managed, role: "MANAGER" },
      { userId, shopId: staffed, role: "STAFF" },
      // Assigned at the retired branch AND a manager there: proves `isActive`
      // is doing the filtering, not the role clause.
      { userId, shopId: retired, role: "MANAGER" },
    ],
  });
});

afterEach(async () => {
  const shopIds = [managed, staffed, hq, retired];
  await prisma.userShop.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
});

/** Only this fixture's shops — the dev database holds the seeded ones too. */
const mine = (shops: { id: string }[], ids: string[]) =>
  shops.filter((s) => ids.includes(s.id)).map((s) => s.id);

describe("reportableShops (D-177)", () => {
  it("offers a mixed-role actor only the shop they MANAGE", async () => {
    const actor = makeActor({ role: "MANAGER", shopIds: [managed], userId });

    const shops = await reportableShops(actor);

    expect(mine(shops, [managed, staffed, hq, retired])).toEqual([managed]);
  });

  it("is strictly narrower than selectableShops for that same actor", async () => {
    // The regression itself, stated directly: the old source offered the
    // staff-only branch, and that is precisely what the picker used to show.
    const actor = makeActor({ role: "MANAGER", shopIds: [managed], userId });

    const selectable = mine(await selectableShops(actor), [managed, staffed]);
    const reportable = mine(await reportableShops(actor), [managed, staffed]);

    expect(selectable).toContain(staffed);
    expect(reportable).not.toContain(staffed);
  });

  it("offers nothing to an actor who manages no shop at all", async () => {
    await prisma.userShop.updateMany({
      where: { userId },
      data: { role: "STAFF" },
    });
    const actor = makeActor({ role: "STAFF", shopIds: [staffed], userId });

    const shops = await reportableShops(actor);

    expect(mine(shops, [managed, staffed, hq, retired])).toEqual([]);
  });

  it("excludes HQ and retired branches, and gives an OWNER every live branch", async () => {
    const actor = makeActor({ role: "OWNER", userId });

    const shops = await reportableShops(actor);

    // An owner holds no UserShop rows, so this also proves the role clause is
    // skipped for them rather than filtering them down to nothing.
    expect(mine(shops, [managed, staffed])).toEqual([managed, staffed]);
    // HQ records no sales (§4.12); a retired branch is not a live filter option.
    expect(mine(shops, [hq, retired])).toEqual([]);
  });
});
