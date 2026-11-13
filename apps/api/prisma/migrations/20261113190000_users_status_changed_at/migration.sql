-- [REVIEW-2499-B S2-1] users.statusChangedAt: when the account's status last changed. "An admin locked out in the last
-- 14 days still counts" (solo approval, the only eligible responder) dated the lock-out by users."updatedAt", which
-- moves on ANY write: an admin suspended long ago, whose row a sweep or a profile fix touched, kept switching off the
-- owner's solo approvals, the solo re-seed, the assisted-uploader approval and SOS self-resolve.
-- The column is written ONLY by these triggers: when an account is created, and on any write that changes status (an
-- admin suspension or ban, a closure, raw SQL alike); nothing else moves it. Nullable and additive.
SET lock_timeout = '10s';

ALTER TABLE "users" ADD COLUMN "statusChangedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION users_stamp_status_changed_at() RETURNS trigger AS $$
BEGIN
  NEW."statusChangedAt" := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_stamp_status_changed_at ON "users";
CREATE TRIGGER users_stamp_status_changed_at BEFORE UPDATE OF "status" ON "users"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION users_stamp_status_changed_at();
-- An account created already locked out (a seed, an import) is dated from its creation, never left undated.
DROP TRIGGER IF EXISTS users_stamp_status_created_at ON "users";
CREATE TRIGGER users_stamp_status_created_at BEFORE INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_stamp_status_changed_at();

-- Backfill, accounts locked out today only: the newest lock-out audit row (an admin suspension or ban, an account
-- closure). With none, the column stays NULL ("changed before this column existed"), which the 14-day rule reads as
-- old. A lock-out made through the product always writes one of these rows in the same transaction.
UPDATE "users" u
SET "statusChangedAt" = a.at
FROM (
  SELECT "entityId", max("createdAt") AS at
  FROM "audit_logs"
  WHERE "entity" = 'User' AND "action" IN ('SUSPEND_USER', 'BAN_USER', 'ACCOUNT_ERASURE_CUTOFF')
  GROUP BY "entityId"
) a
WHERE a."entityId" = u."id" AND u."status" IN ('SUSPENDED', 'BANNED', 'DEACTIVATED');
