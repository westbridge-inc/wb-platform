import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { SEALED_PHOTO_KEY_WHERE } from '../../providers/storage/sealed-photo';

/**
 * [Row 249 · COORD 17:09Z option A] How long an upload may stay unclaimed while the account is open.
 * POST /verification/upload stores one encrypted object per file; one that never becomes a document
 * (an onboarding left halfway, the identity check's selfie, which is checked but never linked) is
 * erased by the daily sweep (user/upload-erasure.ts sweepStaleUnclaimedUploads) once it is older.
 */
export const UNCLAIMED_UPLOAD_DAYS = 30;
/** The last age at which an upload can still be claimed: one day inside the sweep's window, so a claim never meets the sweep. */
export const UPLOAD_CLAIM_DAYS = UNCLAIMED_UPLOAD_DAYS - 1;
export const UPLOAD_DAY_MS = 86_400_000;

/** A document or an identity check refuses an upload older than UPLOAD_CLAIM_DAYS: the person sends it again. */
export function assertClaimableUpload(object: { createdAt: Date }, now: Date = new Date()): void {
  if (now.getTime() - object.createdAt.getTime() > UPLOAD_CLAIM_DAYS * UPLOAD_DAY_MS) {
    throw new AppError(409, 'UPLOAD_TOO_OLD', 'This photo was sent too long ago to use. Please take or choose it again.');
  }
}

/**
 * [FABLE-02 F12 · 13 Nov 2026] At most this many uploads in a day that no document names, per account. A real
 * onboarding files each upload at once (a retake files a new document), so unclaimed ones are only the rare
 * failed filing; without a cap, any signed-in account could store 20 files of 5 MB a minute for 30 days each.
 * A rolling day, not the 30-day window: a person who hits it waits hours, never a month.
 */
export const MAX_UNCLAIMED_UPLOADS_PER_DAY = 20;

/**
 * Refuses (429) an upload while the account holds MAX_UNCLAIMED_UPLOADS_PER_DAY unclaimed uploads from the last day.
 * [REVIEW-2498-A S4-2] "Claimed" here means a document names it. The erasure sweep also counts the legacy mover
 * columns and an account recovery's photos as claims; those flows are rare and, at worst, use a place in a rolling
 * day. A check-then-store, so uploads sent at the same instant can pass it by a few: a soft cap on storage, by design.
 */
export async function assertUnclaimedUploadRoom(db: Pick<PrismaClient, 'encryptedObject' | 'verificationDocument'>, userId: string, now: Date = new Date()): Promise<void> {
  const recent = await db.encryptedObject.findMany({
    // A sealed photo (profile photo, shift selfie) is not an upload; its own folder says so.
    where: { createdBy: userId, shreddedAt: null, createdAt: { gte: new Date(now.getTime() - UPLOAD_DAY_MS) }, NOT: SEALED_PHOTO_KEY_WHERE },
    select: { fileKey: true }, take: 500,
  });
  if (recent.length < MAX_UNCLAIMED_UPLOADS_PER_DAY) return;
  const claimed = await db.verificationDocument.count({ where: { fileUrl: { in: recent.map((r) => r.fileKey) } } });
  if (recent.length - claimed >= MAX_UNCLAIMED_UPLOADS_PER_DAY) {
    throw new AppError(429, 'TOO_MANY_UNCLAIMED_UPLOADS', 'You have sent many photos today that were not added to a document. Add a document with a photo you sent, or try again tomorrow.');
  }
}
