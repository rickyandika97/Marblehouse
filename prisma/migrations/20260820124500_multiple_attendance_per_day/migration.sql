-- Staff can work more than one configured shift in a business day, including
-- at different shops. Retire the day-wide constraint that made the second
-- clock-in impossible, while retaining a database-level double-tap guard for
-- the same scheduled shift.
DROP INDEX "public"."Attendance_userId_businessDate_key";

CREATE UNIQUE INDEX "Attendance_userId_businessDate_shiftId_key"
  ON "public"."Attendance"("userId", "businessDate", "shiftId");

-- PostgreSQL treats NULLs as distinct in a normal unique index. A person using
-- “No shift applies” still needs one record per shop/day, so guard that case
-- explicitly without preventing a no-shift arrival at another branch.
CREATE UNIQUE INDEX "Attendance_userId_businessDate_shopId_noShift_key"
  ON "public"."Attendance"("userId", "businessDate", "shopId")
  WHERE "shiftId" IS NULL;
