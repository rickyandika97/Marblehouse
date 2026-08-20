-- D-122: role becomes per-shop. UserShop gains role/canEnterCost, backfilled
-- from the owning user's (still-present) global role/canEnterCost. User
-- gains isOwner, backfilled from role = 'OWNER'. User.role/canEnterCost are
-- NOT dropped here — they are dropped in a later migration once every call
-- site reads UserShop.role instead (see D-122 in BUILD-LOG.md).

-- AlterTable: add nullable first, backfill, then tighten to NOT NULL.
ALTER TABLE "public"."UserShop" ADD COLUMN     "canEnterCost" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "role" "public"."Role";

-- AlterTable
ALTER TABLE "public"."user" ADD COLUMN     "isOwner" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every existing UserShop row inherits its user's current global
-- role/canEnterCost. Safe because, before this migration, a user only ever
-- had one role — there is no ambiguity to resolve.
UPDATE "public"."UserShop" us
SET "role" = u."role",
    "canEnterCost" = u."canEnterCost"
FROM "public"."user" u
WHERE u.id = us."userId";

-- Backfill isOwner from the (still-present) role column.
UPDATE "public"."user" SET "isOwner" = true WHERE "role" = 'OWNER';

-- Defensive: an OWNER should never hold a UserShop row (setShopAssignment
-- already refuses to create one). Delete any that exist rather than give an
-- owner a per-shop role, since OWNER stays a global-only concept.
DELETE FROM "public"."UserShop" us
USING "public"."user" u
WHERE u.id = us."userId" AND u."role" = 'OWNER';

-- Now safe to tighten.
ALTER TABLE "public"."UserShop" ALTER COLUMN "role" SET NOT NULL;

-- DB-enforced invariant: OWNER is never a per-shop role.
ALTER TABLE "public"."UserShop" ADD CONSTRAINT "UserShop_role_not_owner_check" CHECK ("role" <> 'OWNER');

-- CreateIndex
CREATE INDEX "UserShop_userId_idx" ON "public"."UserShop"("userId");

-- CreateIndex
CREATE INDEX "user_isOwner_banned_idx" ON "public"."user"("isOwner", "banned");
