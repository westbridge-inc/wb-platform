-- [DT-OVERFLOW · owner 14 Nov 2026] Automatic delivery overflow for branches connected to a kitchen system (Dragontail).
-- A connected branch that delivers with its own drivers sends its cash deliveries to the kitchen system. When it is
-- busy, Swift now decides ORDER BY ORDER, BEFORE anything is sent, whether a delivery goes to the kitchen system (the
-- branch's own drivers) or to the Swift tablet and Swift riders: never both. Pickups never move.
--
-- FORWARD
--  1. Enums KitchenOverflowMode (NONE, AUTO_DRIVER_CHECK, BUSY_HOURS, BOTH) and KitchenRoute (KITCHEN, SWIFT_RIDERS).
--  2. vendor_integrations: "overflowMode" (NOT NULL DEFAULT 'NONE': every branch stays off), "overflowBusyHours"
--     (NOT NULL DEFAULT '[]': no busy hours) and "overflowUpdatedAt" (nullable). Constant defaults: no table rewrite.
--  2b. [DT-OUTAGE] vendor_integrations: the kitchen-link breaker — "linkFailures" (NOT NULL DEFAULT 0),
--     "linkFirstFailureAt", "linkOfflineAt", "linkProbeAt" (nullable). Null "linkOfflineAt" = online (as today).
--  2c. [round 2] vendor_integrations: "linkOutageSince" (the outage a link is in until a real send works: one alert pair
--     per outage), and the kitchen tick's latest driver check: "driverCheckAt", "driverCheckFree", "driverCheckProblem"
--     (all nullable). order_integration_syncs: "maybeInKitchen" (NOT NULL DEFAULT false: a constant default, no rewrite).
--  3. orders: "kitchenRoute", "kitchenRouteReason", "kitchenRouteAt", all nullable with no default (a catalogue change
--     only, no rewrite, no scan). Written once per such order by the kitchen claim, only while DRAGONTAIL_INTEGRATION is
--     on; null for every other order.
--
-- Nothing reads or writes these while DRAGONTAIL_INTEGRATION is off (production: off), except the store's order screen,
-- which shows a route only when one was recorded. Not platform config: no re-seed.
--
-- ROLLBACK: code only, drop nothing (rollback.sql beside this file says why).

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

CREATE TYPE "KitchenOverflowMode" AS ENUM ('NONE', 'AUTO_DRIVER_CHECK', 'BUSY_HOURS', 'BOTH');

CREATE TYPE "KitchenRoute" AS ENUM ('KITCHEN', 'SWIFT_RIDERS');

ALTER TABLE "vendor_integrations"
  ADD COLUMN "overflowMode" "KitchenOverflowMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "overflowBusyHours" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "overflowUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "linkFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "linkFirstFailureAt" TIMESTAMP(3),
  ADD COLUMN "linkOfflineAt" TIMESTAMP(3),
  ADD COLUMN "linkProbeAt" TIMESTAMP(3),
  ADD COLUMN "linkOutageSince" TIMESTAMP(3),
  ADD COLUMN "driverCheckAt" TIMESTAMP(3),
  ADD COLUMN "driverCheckFree" INTEGER,
  ADD COLUMN "driverCheckProblem" TEXT;

ALTER TABLE "order_integration_syncs"
  ADD COLUMN "maybeInKitchen" BOOLEAN NOT NULL DEFAULT false;

-- The busy hours are always a JSON list (the server validates each window; this keeps a hand edit honest).
ALTER TABLE "vendor_integrations"
  ADD CONSTRAINT "vendor_integrations_overflow_busy_hours_list" CHECK (jsonb_typeof("overflowBusyHours") = 'array');

ALTER TABLE "orders"
  ADD COLUMN "kitchenRoute" "KitchenRoute",
  ADD COLUMN "kitchenRouteReason" TEXT,
  ADD COLUMN "kitchenRouteAt" TIMESTAMP(3);
