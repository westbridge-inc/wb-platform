-- [#2412] A customer's order, ride and parcel reads look up Swift support's own audit rows for that order
-- (customer-cancellation.ts orderPeople: who closed it, and whose notes the customer may read), by entityId.
-- Without an index every such read scanned the whole append-only table. Built online. Its own migration:
-- CONCURRENTLY cannot run inside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_logs_entityId_idx" ON "audit_logs"("entityId");
