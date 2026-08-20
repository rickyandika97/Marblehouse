-- D-122, second migration: drop User.role and User.canEnterCost now that
-- every call site reads UserShop.role/canEnterCost (per-shop) and
-- User.isOwner (global) instead. Confirmed via grep + a full green
-- typecheck/lint/test pass before this migration was written — see
-- BUILD-LOG.md D-122 for the sweep this closes out.
--
-- Also drops the old @@index([role, banned]) — superseded by
-- @@index([isOwner, banned]), added in the additive migration.

DROP INDEX "public"."user_role_banned_idx";

ALTER TABLE "public"."user" DROP COLUMN "role";
ALTER TABLE "public"."user" DROP COLUMN "canEnterCost";
