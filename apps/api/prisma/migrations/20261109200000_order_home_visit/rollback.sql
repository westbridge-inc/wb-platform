-- [OWNER-ASKS · security review 9 Nov 2026] Drops the home-visit marker. The gate then has no marker to read: deploy
-- the code that reads it only with this column present.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "orders" DROP COLUMN IF EXISTS "homeVisit";
COMMIT;
