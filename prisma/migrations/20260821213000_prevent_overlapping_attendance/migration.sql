-- A staff member may only be clocked into one shift at a time. The service
-- checks this before it processes a camera photo; this partial index is the
-- race-safe backstop for concurrent requests.
CREATE UNIQUE INDEX "Attendance_userId_open_shift_key"
  ON "public"."Attendance" ("userId")
  WHERE "clockOutAt" IS NULL;
