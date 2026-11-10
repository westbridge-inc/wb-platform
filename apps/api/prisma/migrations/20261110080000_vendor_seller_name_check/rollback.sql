-- Rollback for 20261110080000_vendor_seller_name_check: drops the three columns (the confirmations they held are lost;
-- the seller block then names no store by its own name until a person confirms again).
SET lock_timeout = '10s';

ALTER TABLE "vendors" DROP COLUMN IF EXISTS "sellerNameCheckedById";
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "sellerNameCheckedAt";
ALTER TABLE "vendors" DROP COLUMN IF EXISTS "sellerNameCheckedName";
