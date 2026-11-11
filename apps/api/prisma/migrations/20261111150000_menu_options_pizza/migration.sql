-- [MENU-OPTIONS · owner 11 Nov 2026] Pizza-grade menu options: a shared option-group library (build once, attach to
-- many items), size sets the price, half-and-half placement with a store price rule, and one level of nested
-- follow-up options. ADDITIVE ONLY: new nullable/defaulted columns and two new tables. Every existing group, option,
-- cart line and order row keeps its meaning (all new flags default off; a NULL snapshot column = a row written before).
--
-- ROLLBACK: rollback.sql beside this file.

SET lock_timeout = '10s';

-- AlterTable
ALTER TABLE "option_groups" ADD COLUMN     "allowHalves" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "halfPricePercent" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "libraryGroupId" TEXT,
ADD COLUMN     "setsPrice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "options" ADD COLUMN     "followUpGroupId" TEXT,
ADD COLUMN     "libraryOptionId" TEXT;

-- AlterTable
ALTER TABLE "order_item_options" ADD COLUMN     "listedPrice" DECIMAL(10,2),
ADD COLUMN     "optionId" TEXT,
ADD COLUMN     "parentOptionName" TEXT,
ADD COLUMN     "placement" TEXT,
ADD COLUMN     "plainGroupName" TEXT,
ADD COLUMN     "plainOptionName" TEXT,
ADD COLUMN     "setsPrice" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "setsPrice" BOOLEAN NOT NULL DEFAULT false,
    "allowHalves" BOOLEAN NOT NULL DEFAULT false,
    "halfPricePercent" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_options" (
    "id" TEXT NOT NULL,
    "modifierGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "followUpGroupId" TEXT,
    "externalCode" TEXT,

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "modifier_groups_tenantId_idx" ON "modifier_groups"("tenantId");

-- CreateIndex
CREATE INDEX "modifier_groups_vendorId_idx" ON "modifier_groups"("vendorId");

-- CreateIndex
CREATE INDEX "modifier_options_modifierGroupId_idx" ON "modifier_options"("modifierGroupId");

-- CreateIndex
CREATE INDEX "modifier_options_followUpGroupId_idx" ON "modifier_options"("followUpGroupId");

-- CreateIndex
CREATE INDEX "option_groups_libraryGroupId_idx" ON "option_groups"("libraryGroupId");

-- CreateIndex
CREATE INDEX "options_followUpGroupId_idx" ON "options"("followUpGroupId");

-- CreateIndex
CREATE INDEX "options_libraryOptionId_idx" ON "options"("libraryOptionId");

-- AddForeignKey
ALTER TABLE "option_groups" ADD CONSTRAINT "option_groups_libraryGroupId_fkey" FOREIGN KEY ("libraryGroupId") REFERENCES "modifier_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options" ADD CONSTRAINT "options_followUpGroupId_fkey" FOREIGN KEY ("followUpGroupId") REFERENCES "option_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options" ADD CONSTRAINT "options_libraryOptionId_fkey" FOREIGN KEY ("libraryOptionId") REFERENCES "modifier_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_followUpGroupId_fkey" FOREIGN KEY ("followUpGroupId") REFERENCES "modifier_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The store's price rule for a half is a percent of the choice's price: 1..100 (100 = full price).
ALTER TABLE "option_groups" ADD CONSTRAINT "option_groups_half_price_percent_check" CHECK ("halfPricePercent" BETWEEN 1 AND 100);
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_half_price_percent_check" CHECK ("halfPricePercent" BETWEEN 1 AND 100);
-- A price-setting group is always "pick exactly one".
ALTER TABLE "option_groups" ADD CONSTRAINT "option_groups_sets_price_pick_one_check"
  CHECK (NOT "setsPrice" OR ("isRequired" AND "minSelect" <= 1 AND "maxSelect" = 1));
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_sets_price_pick_one_check"
  CHECK (NOT "setsPrice" OR ("isRequired" AND "minSelect" <= 1 AND "maxSelect" = 1));
-- An order line's choice is placed on the whole item or one half, or (any other group) has no placement.
ALTER TABLE "order_item_options" ADD CONSTRAINT "order_item_options_placement_check"
  CHECK ("placement" IS NULL OR "placement" IN ('WHOLE', 'LEFT', 'RIGHT'));
-- At most one price-setting group per item.
CREATE UNIQUE INDEX "option_groups_one_sets_price_per_item" ON "option_groups"("itemId") WHERE "setsPrice";

-- A follow-up group belongs to the SAME item as the option that opens it, and is never the option's own group.
CREATE OR REPLACE FUNCTION options_follow_up_same_item() RETURNS trigger AS $$
DECLARE own_item TEXT; follow_item TEXT;
BEGIN
  IF NEW."followUpGroupId" IS NULL THEN RETURN NEW; END IF;
  IF NEW."followUpGroupId" = NEW."optionGroupId" THEN
    RAISE EXCEPTION 'options row %: an option cannot open its own group [MENU-OPTIONS]', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT "itemId" INTO own_item FROM option_groups WHERE id = NEW."optionGroupId";
  SELECT "itemId" INTO follow_item FROM option_groups WHERE id = NEW."followUpGroupId";
  IF own_item IS DISTINCT FROM follow_item THEN
    RAISE EXCEPTION 'options row %: a follow-up group must belong to the same item [MENU-OPTIONS]', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS options_follow_up_same_item ON options;
CREATE TRIGGER options_follow_up_same_item BEFORE INSERT OR UPDATE OF "followUpGroupId", "optionGroupId" ON options
  FOR EACH ROW EXECUTE FUNCTION options_follow_up_same_item();

-- A library follow-up belongs to the same store's library and is never the option's own group.
CREATE OR REPLACE FUNCTION modifier_options_follow_up_same_store() RETURNS trigger AS $$
DECLARE own_vendor TEXT; follow_vendor TEXT;
BEGIN
  IF NEW."followUpGroupId" IS NULL THEN RETURN NEW; END IF;
  IF NEW."followUpGroupId" = NEW."modifierGroupId" THEN
    RAISE EXCEPTION 'modifier_options row %: an option cannot open its own group [MENU-OPTIONS]', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT "vendorId" INTO own_vendor FROM modifier_groups WHERE id = NEW."modifierGroupId";
  SELECT "vendorId" INTO follow_vendor FROM modifier_groups WHERE id = NEW."followUpGroupId";
  IF own_vendor IS DISTINCT FROM follow_vendor THEN
    RAISE EXCEPTION 'modifier_options row %: a follow-up group must be in the same store library [MENU-OPTIONS]', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS modifier_options_follow_up_same_store ON modifier_options;
CREATE TRIGGER modifier_options_follow_up_same_store BEFORE INSERT OR UPDATE OF "followUpGroupId", "modifierGroupId" ON modifier_options
  FOR EACH ROW EXECUTE FUNCTION modifier_options_follow_up_same_store();

-- An item's copy of a library group is a copy of ITS OWN store's library.
CREATE OR REPLACE FUNCTION option_groups_library_same_store() RETURNS trigger AS $$
DECLARE item_vendor TEXT; library_vendor TEXT;
BEGIN
  IF NEW."libraryGroupId" IS NULL THEN RETURN NEW; END IF;
  SELECT "vendorId" INTO item_vendor FROM items WHERE id = NEW."itemId";
  SELECT "vendorId" INTO library_vendor FROM modifier_groups WHERE id = NEW."libraryGroupId";
  IF item_vendor IS DISTINCT FROM library_vendor THEN
    RAISE EXCEPTION 'option_groups row %: a shared group can be attached only to its own store items [MENU-OPTIONS]', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS option_groups_library_same_store ON option_groups;
CREATE TRIGGER option_groups_library_same_store BEFORE INSERT OR UPDATE OF "libraryGroupId", "itemId" ON option_groups
  FOR EACH ROW EXECUTE FUNCTION option_groups_library_same_store();

-- Tenant lineage (tenantLineageDdl(), the modifier_groups rule) and the canonical wall (rlsDdlFor).
CREATE OR REPLACE FUNCTION modifier_groups_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM vendors WHERE id = NEW."vendorId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'modifier_groups row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."vendorId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'modifier_groups row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."vendorId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS modifier_groups_tenant_matches_vendor ON modifier_groups;
CREATE TRIGGER modifier_groups_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "vendorId" ON modifier_groups FOR EACH ROW EXECUTE FUNCTION modifier_groups_tenant_matches_vendor();
ALTER TABLE "modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "modifier_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "modifier_groups";
CREATE POLICY "tenant_isolation" ON "modifier_groups"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
