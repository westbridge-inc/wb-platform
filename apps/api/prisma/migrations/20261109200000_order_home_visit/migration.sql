-- [OWNER-ASKS · security review 9 Nov 2026] An explicit home-visit marker on an appointment order, written at
-- checkout (true or false). The home-visit gate (clearance, profile photo, a person's match with the approved ID) re-runs
-- on accept and reschedule from this marker, never from the billable distance. NULL = not known: read as a home visit
-- (fail closed, isHomeVisitOrder).
-- [review M1] orders and items FORCE row-level security: a migration binds no tenant, so the backfill runs with row
-- security off (precedent: 20261005210300_qr_token_identity). Under a role that may not bypass it, this errors instead
-- of silently updating nothing.
SET row_security = off;
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "homeVisit" BOOLEAN;

-- BACKFILL 1: clearly a home visit: a frozen billable distance, a listing that only travels, or an address that is not
-- the business's own pin.
UPDATE "orders" o SET "homeVisit" = true
WHERE o."fulfillment" = 'APPOINTMENT'
  AND (
    (o."billableKm" IS NOT NULL AND o."billableKm" > 0)
    OR EXISTS (SELECT 1 FROM "order_items" oi JOIN "items" i ON i."id" = oi."itemId" WHERE oi."orderId" = o."id" AND i."bookingConfig"->>'serviceMode' = 'MOBILE')
    OR EXISTS (SELECT 1 FROM "vendors" v WHERE v."id" = o."vendorId" AND (o."deliveryLat" IS DISTINCT FROM v."latitude" OR o."deliveryLng" IS DISTINCT FROM v."longitude"))
  );

-- BACKFILL 2: clearly in-shop: every listing on the order is served only at the business's place. Anything else (a BOTH
-- listing at the business's own pin) stays NULL, which the gate reads as a home visit.
UPDATE "orders" o SET "homeVisit" = false
WHERE o."fulfillment" = 'APPOINTMENT' AND o."homeVisit" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "order_items" oi JOIN "items" i ON i."id" = oi."itemId" WHERE oi."orderId" = o."id" AND COALESCE(i."bookingConfig"->>'serviceMode', 'AT_BUSINESS') <> 'AT_BUSINESS');
