DROP TRIGGER IF EXISTS users_stamp_status_created_at ON "users";
DROP TRIGGER IF EXISTS users_stamp_status_changed_at ON "users";
DROP FUNCTION IF EXISTS users_stamp_status_changed_at();
ALTER TABLE "users" DROP COLUMN IF EXISTS "statusChangedAt";
