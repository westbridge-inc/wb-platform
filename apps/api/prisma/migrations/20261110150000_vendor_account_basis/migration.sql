-- [COMPANY-DOCS · owner rulings 10 Nov 2026] Who holds a store account, chosen at sign-up: OWNER (the owner of a registered
-- business, or a person trading under their own name), COMPANY (a registered company; the holder manages its Swift account)
-- or MANAGER (the manager of a registered business, not its owner). It decides the papers the whole account gives
-- (verification/doc-registry). Every existing account keeps the papers it has today (default OWNER).
-- vendor_owners is read on every store request: wait at most 10 s for the lock, then fail (retry) instead of queueing
-- reads behind the ALTER. A constant default makes the ADD COLUMN itself metadata-only.
SET lock_timeout = '10s';
CREATE TYPE "VendorAccountBasis" AS ENUM ('OWNER', 'COMPANY', 'MANAGER');
ALTER TABLE "vendor_owners" ADD COLUMN "accountBasis" "VendorAccountBasis" NOT NULL DEFAULT 'OWNER';
