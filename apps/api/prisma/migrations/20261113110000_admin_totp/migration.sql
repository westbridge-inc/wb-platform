-- [AUDIT-20261113 FABLE-03 #2] A second factor for the admin console (authenticator app, TOTP).
--   admins.totp*        the encrypted secret (MASTER_KEK envelope; never stored in clear), a pending enrolment,
--                       when it was confirmed, the last accepted 30-second step (a code works once), and the
--                       SHA-256 digests of the unused recovery codes.
--   sessions.mfaVerifiedAt  when THIS session proved an authenticator code.
-- Enforcement is off until ADMIN_TOTP_REQUIRED=1 (the owner enrols first). Additive: nullable / defaulted columns.
ALTER TABLE "admins" ADD COLUMN "totpSecretEnc" TEXT;
ALTER TABLE "admins" ADD COLUMN "totpPendingSecretEnc" TEXT;
ALTER TABLE "admins" ADD COLUMN "totpPendingAt" TIMESTAMP(3);
ALTER TABLE "admins" ADD COLUMN "totpEnabledAt" TIMESTAMP(3);
ALTER TABLE "admins" ADD COLUMN "totpLastStep" INTEGER;
ALTER TABLE "admins" ADD COLUMN "totpRecoveryHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "sessions" ADD COLUMN "mfaVerifiedAt" TIMESTAMP(3);
