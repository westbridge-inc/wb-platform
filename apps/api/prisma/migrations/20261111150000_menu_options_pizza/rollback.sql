-- ROLLBACK of 20261111150000_menu_options_pizza. Refuse once any order snapshot used the new columns
-- (an order's words must never be lost); otherwise drop what the migration added.
-- [DELTA REVIEW S3-N1] One transaction, like the kitchen rollback: a refused guard aborts it, so nothing is dropped
-- (under a plain `psql -f` too, which goes on after an error: every later statement fails, COMMIT becomes ROLLBACK).
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM order_item_options WHERE "placement" IS NOT NULL OR "setsPrice" OR "parentOptionName" IS NOT NULL) THEN
    RAISE EXCEPTION 'menu options rollback refused: orders already carry half-and-half, size or nested choices';
  END IF;
END $$;
-- [REVIEW A S3-2] Refuse while any MENU uses the rules too: the older code prices a size as an add-on on top of the
-- item's "from" price (a Large = from price + Large) and shows a follow-up group as always open, so rolling back (or
-- only reverting the code) would overcharge every sized item. NEUTRALISE FIRST (runbook): for each size group set each
-- size to (its price - the LOWEST size, sold-out sizes included) as an add-on, set the item to that lowest size (what
-- the tools' switch-off does, delta review S2-N1), clear "setsPrice"/"allowHalves"
-- and every "followUpGroupId"; then this rollback runs.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM option_groups WHERE "setsPrice" OR "allowHalves")
     OR EXISTS (SELECT 1 FROM options WHERE "followUpGroupId" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM modifier_groups WHERE "setsPrice" OR "allowHalves")
     OR EXISTS (SELECT 1 FROM modifier_options WHERE "followUpGroupId" IS NOT NULL) THEN
    RAISE EXCEPTION 'menu options rollback refused: menus use sizes, halves or follow-up choices; neutralise them first (see the runbook line in this file)';
  END IF;
END $$;
DROP TRIGGER IF EXISTS option_groups_library_same_store ON option_groups;
DROP FUNCTION IF EXISTS option_groups_library_same_store();
DROP TRIGGER IF EXISTS modifier_options_follow_up_same_store ON modifier_options;
DROP FUNCTION IF EXISTS modifier_options_follow_up_same_store();
DROP TRIGGER IF EXISTS options_follow_up_same_item ON options;
DROP FUNCTION IF EXISTS options_follow_up_same_item();
DROP TRIGGER IF EXISTS modifier_groups_tenant_matches_vendor ON modifier_groups;
DROP FUNCTION IF EXISTS modifier_groups_tenant_matches_vendor();
DROP INDEX IF EXISTS "option_groups_one_sets_price_per_item";
ALTER TABLE "order_item_options" DROP CONSTRAINT IF EXISTS "order_item_options_placement_check",
  DROP COLUMN IF EXISTS "plainGroupName", DROP COLUMN IF EXISTS "plainOptionName", DROP COLUMN IF EXISTS "placement",
  DROP COLUMN IF EXISTS "parentOptionName", DROP COLUMN IF EXISTS "setsPrice", DROP COLUMN IF EXISTS "listedPrice",
  DROP COLUMN IF EXISTS "optionId";
ALTER TABLE "options" DROP CONSTRAINT IF EXISTS "options_followUpGroupId_fkey", DROP CONSTRAINT IF EXISTS "options_libraryOptionId_fkey",
  DROP COLUMN IF EXISTS "followUpGroupId", DROP COLUMN IF EXISTS "libraryOptionId";
ALTER TABLE "option_groups" DROP CONSTRAINT IF EXISTS "option_groups_libraryGroupId_fkey",
  DROP CONSTRAINT IF EXISTS "option_groups_half_price_percent_check", DROP CONSTRAINT IF EXISTS "option_groups_sets_price_pick_one_check",
  DROP COLUMN IF EXISTS "setsPrice", DROP COLUMN IF EXISTS "allowHalves", DROP COLUMN IF EXISTS "halfPricePercent",
  DROP COLUMN IF EXISTS "libraryGroupId";
DROP TABLE IF EXISTS "modifier_options";
DROP TABLE IF EXISTS "modifier_groups";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111150000_menu_options_pizza';
COMMIT;
