/*
  Warnings:

  - You are about to drop the column `effectiveTo` on the `ScheduleAssignment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."ScheduleAssignment" DROP COLUMN "effectiveTo",
ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "removedById" TEXT;

-- CreateTable
CREATE TABLE "public"."ScheduleLeave" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ScheduleLeave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleLeave_userId_startDate_endDate_idx" ON "public"."ScheduleLeave"("userId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "ScheduleLeave_shopId_startDate_idx" ON "public"."ScheduleLeave"("shopId", "startDate");

-- CreateIndex
CREATE INDEX "ScheduleAssignment_shopId_removedAt_idx" ON "public"."ScheduleAssignment"("shopId", "removedAt");

-- AddForeignKey
ALTER TABLE "public"."ScheduleLeave" ADD CONSTRAINT "ScheduleLeave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduleLeave" ADD CONSTRAINT "ScheduleLeave_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
