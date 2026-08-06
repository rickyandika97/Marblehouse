-- Make the business-day boundary GLOBAL instead of per-shop.
--
-- PRD §4.2 / correction C-1 always specified a single global hour; the column
-- on Shop was drift that survived Phase 0 (recorded as BUILD-LOG D-17, resolved
-- as D-18). Owner decision, 4 Aug 2026: one global cutoff at 04:00.
--
-- Why global: daily reporting groups by businessDate. Two branches on different
-- hours would make a combined revenue report sum two different definitions of
-- "a day" — wrong in a way nobody spots, because the total still looks
-- plausible. Per-branch OPENING hours are a separate concern and live in Shift.
--
-- Order matters here. The setting is written BEFORE the column is dropped, so
-- an existing database carries its configured value forward instead of silently
-- adopting a new default.

-- 1. Seed the global setting from the existing data.
--    MIN() because if branches somehow disagree, the earliest cutoff is the
--    safe choice: it can only move a record to the day it was already likely
--    filed under, never split a shift that was previously whole.
--    COALESCE covers a fresh database where no shop row exists yet.
INSERT INTO "public"."AppSetting" ("key", "value", "updatedAt")
SELECT
  'businessDayStartHour',
  COALESCE(MIN("dayStartHour"), 4)::text::jsonb,
  NOW()
FROM "public"."Shop"
ON CONFLICT ("key") DO NOTHING;

-- 2. Guarantee the row exists even when the Shop table was empty.
INSERT INTO "public"."AppSetting" ("key", "value", "updatedAt")
VALUES ('businessDayStartHour', '4'::jsonb, NOW())
ON CONFLICT ("key") DO NOTHING;

-- 3. Drop the per-shop column.
ALTER TABLE "public"."Shop" DROP COLUMN "dayStartHour";
