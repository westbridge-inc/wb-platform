-- [R3 · CAA s.70(1) · owner ruling 10 Nov 2026 · review F1] The business's or company's legal name, typed by the person
-- at Swift who approved its registration paper, from that paper: one per account (every store and branch is sold by it;
-- the store name stays the trading name). The storefront shows it as the seller's legal name only while that paper is
-- a VALID record. Additive: four nullable columns, no backfill (no paper was approved with a typed name before this).
-- Timestamped after 20261110150000 (company sign-up, #2470) per its interface note.
--
-- ROLLBACK: rollback.sql beside this file.

SET lock_timeout = '10s';

ALTER TABLE "vendor_owners" ADD COLUMN "sellerLegalName" TEXT;
ALTER TABLE "vendor_owners" ADD COLUMN "sellerLegalNameAt" TIMESTAMP(3);
ALTER TABLE "vendor_owners" ADD COLUMN "sellerLegalNameById" TEXT;
ALTER TABLE "vendor_owners" ADD COLUMN "sellerLegalNameDocId" TEXT;
