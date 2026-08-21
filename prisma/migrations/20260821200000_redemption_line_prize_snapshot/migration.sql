-- Customer redemption history is an accounting record, not a live catalog view.
-- Backfill while the existing required prize relation is still available, then
-- remove the default so every new line must explicitly provide its snapshot.
ALTER TABLE "RedemptionLine"
ADD COLUMN "prizeName" TEXT NOT NULL DEFAULT '';

UPDATE "RedemptionLine" AS line
SET "prizeName" = prize."name"
FROM "PrizeItem" AS prize
WHERE prize."id" = line."prizeItemId";

ALTER TABLE "RedemptionLine"
ALTER COLUMN "prizeName" DROP DEFAULT;
