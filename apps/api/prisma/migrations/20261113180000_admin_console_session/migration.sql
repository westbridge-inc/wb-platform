-- [REVIEW-2501-A S3-1] sessions.consoleBoundAt: set when the admin web console's own sign-in issued the session
-- (credentials only as HttpOnly cookies to the console origin). ADMIN_API_CONSOLE_ONLY=1 accepts only such a session.
-- Additive and nullable.
ALTER TABLE "sessions" ADD COLUMN "consoleBoundAt" TIMESTAMP(3);
