-- [OWNER-ASKS · security review 9 Nov 2026] An explicit home-visit marker on an appointment order, written at
-- checkout. The home-visit gate (clearance, profile photo, a person's match with the approved ID) re-runs on accept
-- and reschedule from this marker, never from the billable distance.
ALTER TABLE "orders" ADD COLUMN "homeVisit" BOOLEAN NOT NULL DEFAULT false;

-- Backfill, fail closed: an appointment already sent to the customer's address (a frozen billable distance), or one
-- whose listing only travels (MOBILE), is a home visit. (A BOTH listing's choice was never stored: those that went to
-- the customer carry a billable distance.)
UPDATE "orders" o SET "homeVisit" = true
WHERE o."fulfillment" = 'APPOINTMENT'
  AND (
    (o."billableKm" IS NOT NULL AND o."billableKm" > 0)
    OR EXISTS (
      SELECT 1 FROM "order_items" oi JOIN "items" i ON i."id" = oi."itemId"
      WHERE oi."orderId" = o."id" AND i."bookingConfig"->>'serviceMode' = 'MOBILE'
    )
  );
