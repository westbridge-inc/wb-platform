-- Rollback for 20261110150000_vendor_account_basis: every account goes back to the owner's papers (a company or manager
-- account would be asked for an owner's ID again). Deploy the code that no longer reads the column first.
ALTER TABLE "vendor_owners" DROP COLUMN IF EXISTS "accountBasis";
DROP TYPE IF EXISTS "VendorAccountBasis";
