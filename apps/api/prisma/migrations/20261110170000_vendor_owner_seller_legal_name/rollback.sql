-- Rollback for 20261110170000_vendor_owner_seller_legal_name: drops the four columns (the typed legal names are lost;
-- the storefront then falls back to a person-confirmed store name, or names nobody).
SET lock_timeout = '10s';

ALTER TABLE "vendor_owners" DROP COLUMN IF EXISTS "sellerLegalNameDocId";
ALTER TABLE "vendor_owners" DROP COLUMN IF EXISTS "sellerLegalNameById";
ALTER TABLE "vendor_owners" DROP COLUMN IF EXISTS "sellerLegalNameAt";
ALTER TABLE "vendor_owners" DROP COLUMN IF EXISTS "sellerLegalName";
