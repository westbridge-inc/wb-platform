-- [KITCHEN-INTEGRATION · owner 11 Nov 2026] A store's orders can go straight to its own kitchen system (Dragontail
-- today), behind DRAGONTAIL_INTEGRATION (default off). While the switch is off nothing writes these tables (no claim,
-- no send, no event, and the console's writing routes and connection test are refused) and only the tablet backstop
-- reads them: the alert ladder (one unique-key read per rung) and the hold-release sweep (one indexed read), so a
-- claim left waiting when the switch was turned off is rung on the store's tablet, never left to auto-cancel.
--
-- FORWARD
--  1. Enums KitchenProvider (DRAGONTAIL) and KitchenSyncState.
--  2. items."externalItemNo" and options."externalItemNo" (nullable, no default): the store's kitchen-catalogue
--     number for a listing and for a choice. A catalogue change only (no rewrite, no scan).
--  3. Table "vendor_integrations": one row per store and provider. No credential is ever stored: secretRef and
--     webhookSecretRef name entries of the DRAGONTAIL_CREDENTIALS secret file.
--  4. Table "order_integration_syncs": at most one row per (order, provider), and one per (connection, external
--     order id), so an order is never sent twice. Table "kitchen_order_counters": Swift's order-number counter per
--     (provider, store number) with its id base frozen at birth, so a recreated or renumbered connection, or a
--     changed DRAGONTAIL_ORDER_ID_BASE, never reuses an id at the kitchen system. Not tenant data: a store number
--     belongs to one Swift store at a time (unique), and the row holds two numbers.
--  5. The tenant wall on both tables: RLS ENABLED and FORCED with the canonical policy (rlsDdlFor), and the tenant
--     lineage triggers (tenantLineageDdl(), byte for byte): a connection is its store's tenant, a sync its order's.
--  6. Shape: an enabled connection names its store number and its login; numbers are positive; a credential
--     reference is the connection's own (derived from its id, unique): never another store's login or secret.
--  7. A connection never changes store or provider (its order syncs name it).
--
-- New, empty tables; the enums are new; the two new columns are nullable with no default.
--
-- ROLLBACK: rollback.sql beside this file (refuses while any order sync exists).

SET lock_timeout = '10s';

-- CreateEnum
CREATE TYPE "KitchenProvider" AS ENUM ('DRAGONTAIL');

-- CreateEnum
CREATE TYPE "KitchenSyncState" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'UNKNOWN', 'FALLBACK', 'CANCEL_QUEUED', 'CANCELLED', 'DONE');

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "externalItemNo" TEXT;

-- AlterTable
ALTER TABLE "options" ADD COLUMN     "externalItemNo" TEXT;

-- CreateTable
CREATE TABLE "vendor_integrations" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "provider" "KitchenProvider" NOT NULL,
    "externalStoreNo" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "secretRef" TEXT,
    "webhookSecretRef" TEXT,
    "pollUpdateStamp" BIGINT NOT NULL DEFAULT 0,
    "lastPolledAt" TIMESTAMP(3),
    "lastHealthyAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_order_counters" (
    "provider" "KitchenProvider" NOT NULL,
    "externalStoreNo" INTEGER NOT NULL,
    "orderIdBase" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kitchen_order_counters_pkey" PRIMARY KEY ("provider","externalStoreNo")
);

-- CreateTable
CREATE TABLE "order_integration_syncs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "vendorIntegrationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "provider" "KitchenProvider" NOT NULL,
    "externalOrderId" INTEGER NOT NULL,
    "dailyNo" INTEGER NOT NULL,
    "state" "KitchenSyncState" NOT NULL DEFAULT 'QUEUED',
    "lastAction" TEXT,
    "lastActionAt" TIMESTAMP(3),
    "updateStamp" BIGINT,
    "promiseSeconds" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "fallbackAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_integration_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_integrations_tenantId_idx" ON "vendor_integrations"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_integrations_secretRef_key" ON "vendor_integrations"("secretRef");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_integrations_webhookSecretRef_key" ON "vendor_integrations"("webhookSecretRef");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_integrations_vendorId_provider_key" ON "vendor_integrations"("vendorId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_integrations_provider_externalStoreNo_key" ON "vendor_integrations"("provider", "externalStoreNo");

-- CreateIndex
CREATE INDEX "order_integration_syncs_state_leaseUntil_idx" ON "order_integration_syncs"("state", "leaseUntil");

-- CreateIndex
CREATE INDEX "order_integration_syncs_tenantId_idx" ON "order_integration_syncs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "order_integration_syncs_orderId_provider_key" ON "order_integration_syncs"("orderId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "order_integration_syncs_vendorIntegrationId_externalOrderId_key" ON "order_integration_syncs"("vendorIntegrationId", "externalOrderId");

-- AddForeignKey
ALTER TABLE "vendor_integrations" ADD CONSTRAINT "vendor_integrations_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_integration_syncs" ADD CONSTRAINT "order_integration_syncs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_integration_syncs" ADD CONSTRAINT "order_integration_syncs_vendorIntegrationId_fkey" FOREIGN KEY ("vendorIntegrationId") REFERENCES "vendor_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 5. The tenant wall (rlsDdlFor), then lineage (tenantLineageDdl). A sync row has two parents: its order and its
--    connection must agree on tenant, store and provider.
ALTER TABLE "vendor_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_integrations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "vendor_integrations";
CREATE POLICY "tenant_isolation" ON "vendor_integrations"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE "order_integration_syncs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_integration_syncs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "order_integration_syncs";
CREATE POLICY "tenant_isolation" ON "order_integration_syncs"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION vendor_integrations_tenant_matches_vendor() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM vendors WHERE id = NEW."vendorId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'vendor_integrations row % names vendors row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."vendorId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'vendor_integrations row % names tenant % but its vendors row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."vendorId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vendor_integrations_tenant_matches_vendor ON vendor_integrations;
CREATE TRIGGER vendor_integrations_tenant_matches_vendor BEFORE INSERT OR UPDATE OF "tenantId", "vendorId" ON vendor_integrations FOR EACH ROW EXECUTE FUNCTION vendor_integrations_tenant_matches_vendor();
CREATE OR REPLACE FUNCTION order_integration_syncs_tenant_matches_order() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT o."tenantId" FROM orders o JOIN vendor_integrations vi ON vi.id = NEW."vendorIntegrationId" WHERE o.id = NEW."orderId" AND vi."tenantId" = o."tenantId" AND vi."vendorId" = o."vendorId" AND vi.provider = NEW.provider INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- A QR UPDATE with a missing/hidden non-null parent is refused too.
          RAISE EXCEPTION 'order_integration_syncs row % names orders row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."orderId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'order_integration_syncs row % names tenant % but its orders row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."orderId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS order_integration_syncs_tenant_matches_order ON order_integration_syncs;
CREATE TRIGGER order_integration_syncs_tenant_matches_order BEFORE INSERT OR UPDATE OF "tenantId", "orderId", "vendorIntegrationId", "provider" ON order_integration_syncs FOR EACH ROW EXECUTE FUNCTION order_integration_syncs_tenant_matches_order();

-- 6. Shape.
ALTER TABLE "vendor_integrations"
  ADD CONSTRAINT "vendor_integrations_enabled_check" CHECK (NOT "enabled" OR ("externalStoreNo" IS NOT NULL AND "secretRef" IS NOT NULL)),
  ADD CONSTRAINT "vendor_integrations_numbers_check" CHECK (("externalStoreNo" IS NULL OR "externalStoreNo" > 0) AND "pollUpdateStamp" >= 0),
  -- [security review · confused deputy] A credential reference is the connection's own, derived from its id: never
  -- another connection's (the unique indexes above also refuse a shared one).
  ADD CONSTRAINT "vendor_integrations_refs_check" CHECK (
    ("secretRef" IS NULL OR "secretRef" = 'kitchen/' || lower("provider"::text) || '/' || "id" || '/login')
    AND ("webhookSecretRef" IS NULL OR "webhookSecretRef" = 'kitchen/' || lower("provider"::text) || '/' || "id" || '/webhook'));
ALTER TABLE "kitchen_order_counters"
  ADD CONSTRAINT "kitchen_order_counters_numbers_check" CHECK ("externalStoreNo" > 0 AND "orderIdBase" >= 0 AND "next" > 0);
ALTER TABLE "order_integration_syncs"
  ADD CONSTRAINT "order_integration_syncs_numbers_check" CHECK ("externalOrderId" > 0 AND "dailyNo" >= 0 AND "attempts" >= 0);

-- 7. A connection never moves to another store or provider: its order syncs name it.
CREATE OR REPLACE FUNCTION vendor_integrations_identity_frozen() RETURNS trigger AS $$
      BEGIN
        IF NEW."vendorId" IS DISTINCT FROM OLD."vendorId" OR NEW."provider" IS DISTINCT FROM OLD."provider" THEN
          RAISE EXCEPTION 'vendor_integrations row % never changes store or provider [KITCHEN-INTEGRATION]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vendor_integrations_identity_frozen ON vendor_integrations;
CREATE TRIGGER vendor_integrations_identity_frozen BEFORE UPDATE OF "vendorId", "provider" ON vendor_integrations FOR EACH ROW EXECUTE FUNCTION vendor_integrations_identity_frozen();
