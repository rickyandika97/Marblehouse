-- Preserve the end time currently attached to every historical scheduled row.
-- The Shift relation is retained for attendance (used shifts are deactivated,
-- not deleted), so this gives old records the same protection from future
-- schedule edits as new clock-ins receive from the application service.
UPDATE "public"."Attendance" AS a
SET "shiftEndAtCapture" = s."endTime"
FROM "public"."Shift" AS s
WHERE a."shiftId" = s."id"
  AND a."shiftEndAtCapture" IS NULL;
