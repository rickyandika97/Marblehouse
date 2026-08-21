-- Branch transfers are immediate by default. Owners can still turn this off
-- for an individual shop when they need a physical receiving confirmation.
ALTER TABLE "Shop" ALTER COLUMN "allowDirectTransfer" SET DEFAULT true;

-- Bring existing shops in line with the new product default as requested.
UPDATE "Shop"
SET "allowDirectTransfer" = true
WHERE "allowDirectTransfer" = false;
