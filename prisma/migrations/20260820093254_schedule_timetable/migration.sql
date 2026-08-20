-- CreateEnum
CREATE TYPE "public"."ScheduleSource" AS ENUM ('SCHEDULED', 'COVER', 'MANUAL');

-- CreateEnum
CREATE TYPE "public"."ScheduleOverrideKind" AS ENUM ('ADDED', 'REMOVED');

-- AlterTable
ALTER TABLE "public"."Attendance" ADD COLUMN     "coverReason" TEXT,
ADD COLUMN     "scheduleSource" "public"."ScheduleSource" NOT NULL DEFAULT 'SCHEDULED';

-- CreateTable
CREATE TABLE "public"."ScheduleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "daysOfWeek" INTEGER[],
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "ScheduleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScheduleOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "kind" "public"."ScheduleOverrideKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ScheduleOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleAssignment_userId_effectiveFrom_idx" ON "public"."ScheduleAssignment"("userId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ScheduleAssignment_shopId_effectiveFrom_idx" ON "public"."ScheduleAssignment"("shopId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ScheduleAssignment_shiftId_idx" ON "public"."ScheduleAssignment"("shiftId");

-- CreateIndex
CREATE INDEX "ScheduleOverride_shopId_businessDate_idx" ON "public"."ScheduleOverride"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "ScheduleOverride_userId_businessDate_idx" ON "public"."ScheduleOverride"("userId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleOverride_userId_shiftId_businessDate_key" ON "public"."ScheduleOverride"("userId", "shiftId", "businessDate");

-- AddForeignKey
ALTER TABLE "public"."ScheduleAssignment" ADD CONSTRAINT "ScheduleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduleAssignment" ADD CONSTRAINT "ScheduleAssignment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduleAssignment" ADD CONSTRAINT "ScheduleAssignment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "public"."Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScheduleOverride" ADD CONSTRAINT "ScheduleOverride_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "public"."Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
