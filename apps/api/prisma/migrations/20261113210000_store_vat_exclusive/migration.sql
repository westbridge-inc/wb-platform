-- [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] Prices BEFORE VAT, then a "VAT 14%" line, then the Total.
-- A VAT-registered store may price before VAT (StoreVatMode PRICES_EXCLUDE_VAT): its typed prices are shown exactly as
-- typed, and each order adds the store's VAT on its standard-rated goods ONCE (half-up to the whole dollar) as its own
-- line, carried in orders."taxAmount" (already inside every total, rider-cash and receipt calculation) and frozen with
-- orders."vatOnTop" = true.
--
-- ADDITIVE ONLY: one enum value and one column with a constant default (no table rewrite). Every existing order reads
-- vatOnTop = false (its VAT, if any, is inside its goods, exactly as before), and no store can choose the new basis until
-- STORE_VAT_EXCLUSIVE is on and a person approves it. Not platform config: no re-seed.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TYPE "StoreVatMode" ADD VALUE IF NOT EXISTS 'PRICES_EXCLUDE_VAT';
ALTER TABLE "orders" ADD COLUMN "vatOnTop" BOOLEAN NOT NULL DEFAULT false;
