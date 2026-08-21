-- A past shift edit must not alter payroll evidence. Keep the scheduled end
-- that applied when the employee clocked in; existing rows fall back to their
-- retained Shift while this nullable field is gradually populated by new work.
ALTER TABLE "public"."Attendance"
ADD COLUMN "shiftEndAtCapture" TIME(3);
