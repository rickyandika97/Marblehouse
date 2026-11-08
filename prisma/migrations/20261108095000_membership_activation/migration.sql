-- Existing customers deliberately start unactivated; no balances or card tokens change.
-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "membershipActivatedAt" TIMESTAMP(3);
