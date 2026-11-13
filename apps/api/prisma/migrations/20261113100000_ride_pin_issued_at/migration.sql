-- [AUDIT-20261113 F2] When the order's CURRENT ride PIN was issued. NULL means "at order creation" (every existing
-- row). Chat history is judged against the live PIN only for messages written after it was issued: an earlier
-- message cannot carry knowledge of a PIN that did not exist yet, and re-judging it on read was an oracle.
-- Additive: one nullable column, no backfill, no existing row changes meaning.
ALTER TABLE "orders" ADD COLUMN "ridePinIssuedAt" TIMESTAMP(3);
