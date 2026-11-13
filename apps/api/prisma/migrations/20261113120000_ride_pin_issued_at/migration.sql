-- [AUDIT-20261113 F2] When the order's CURRENT ride PIN was issued. NULL means "at order creation" (every existing
-- row). Chat history is judged against the live PIN only for messages written after it was issued: an earlier
-- message cannot carry knowledge of a PIN that did not exist yet, and re-judging it on read was an oracle.
-- The pickup code can be re-issued too (support rotation): pickupCodeIssuedAt is the same fact for it.
-- Additive: two nullable columns, no backfill, no existing row changes meaning.
-- [REVIEW-2499-B S4-1] As every orders migration: never queue every order read and write behind a long transaction.
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "ridePinIssuedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "pickupCodeIssuedAt" TIMESTAMP(3);
