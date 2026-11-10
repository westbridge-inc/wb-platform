-- [R3 · owner ruling 10 Nov 2026 · security review] The exact store name a PERSON at Swift confirmed as the seller's
-- business or company name. The storefront's seller block names a store by its own name only while the store's name
-- still equals this one; with no confirmation it names nobody ("Ask the store"), never the owner's personal name.
-- Additive: three nullable columns, no backfill (no person has confirmed any store's name yet).
--
-- ROLLBACK: rollback.sql beside this file.

SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN "sellerNameCheckedName" TEXT;
ALTER TABLE "vendors" ADD COLUMN "sellerNameCheckedAt" TIMESTAMP(3);
ALTER TABLE "vendors" ADD COLUMN "sellerNameCheckedById" TEXT;
