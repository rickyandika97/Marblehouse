-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "membershipToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- CreateTable
CREATE TABLE "CustomerVerification" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT,
    "customerId" TEXT NOT NULL,
    "membershipToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerVerification_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE INDEX "CustomerVerification_expiresAt_idx" ON "CustomerVerification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_membershipToken_key" ON "Customer"("membershipToken");

-- AddForeignKey
ALTER TABLE "CustomerVerification" ADD CONSTRAINT "CustomerVerification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
