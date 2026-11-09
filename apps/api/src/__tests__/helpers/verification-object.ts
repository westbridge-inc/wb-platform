import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { afterAll } from 'vitest';

const seeded = new Map<PrismaClient, string[]>();
afterAll(async () => {
  for (const [db, keys] of seeded) await db.encryptedObject.deleteMany({ where: { fileKey: { in: keys } } });
});

/** Explicit per-subject metadata for tests whose processor is a stub. These
 * fixtures do not claim storage/encryption integration; byte/render suites use
 * the real upload route. Keep sandbox verdict markers in the safe basename. */
export async function ownedVerificationFixture(db: PrismaClient, userId: string, marker = 'manual'): Promise<string> {
  const label = marker.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 160);
  const fileKey = `/uploads/verification/${userId}/${nanoid(16)}-${label}.enc`;
  await db.encryptedObject.create({ data: {
    fileKey, createdBy: userId, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2),
    wrappedDek: Buffer.alloc(60, 3), mimeType: 'image/jpeg', sizeBytes: 1,
    sha256: createHash('sha256').update(fileKey).digest('hex'),
  } });
  seeded.set(db, [...(seeded.get(db) ?? []), fileKey]);
  return fileKey;
}

/** Model the server-owned pointer produced by POST /auth/selfie. */
export async function signupSelfieFixture(db: PrismaClient, userId: string): Promise<string> {
  const avatar = `/uploads/avatars/${userId}/${nanoid(16)}.jpg`;
  await db.user.update({ where: { id: userId }, data: { avatar, selfieCapturedAt: new Date() } });
  return avatar;
}

/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026 ~20:1xZ (A)] A pro (or a home-visit owner) ready for home work: their own selfie
 * (as POST /auth/selfie writes it) and a person's recorded MATCH of THAT selfie against an approved, current photo ID
 * (as POST /admin/verification/:id/selfie-check writes it). An approved ID already on file is used; otherwise a review
 * fixture ID (no stored image) is committed. Callers own the tenant binding.
 */
export async function homeWorkReadyFixture(db: PrismaClient, userId: string, reviewerId = 'synthetic-reviewer'): Promise<void> {
  const avatar = `avatars/${userId}/${nanoid(16)}.jpg`;
  const user = await db.user.update({ where: { id: userId }, data: { avatar, selfieCapturedAt: new Date() }, select: { selfieCapturedAt: true } });
  const id = await db.verificationDocument.findFirst({
    where: { userId, status: 'APPROVED', state: 'COMMITTED', docType: { in: ['national_id', 'owner_national_id', 'passport', 'drivers_licence'] } },
    orderBy: { reviewedAt: 'desc' }, select: { id: true },
  }) ?? await db.verificationDocument.create({ data: {
    userId, role: 'CUSTOMER', docType: 'national_id', fileUrl: '', status: 'APPROVED', state: 'COMMITTED',
    reviewedAt: new Date(), reviewedBy: reviewerId, consentAt: new Date(), privacyNoticeVersion: 'v1',
  }, select: { id: true } });
  await db.auditLog.create({ data: {
    userId: reviewerId, action: 'SELFIE_ID_COMPARED', entity: 'User', entityId: userId,
    changes: { documentId: id.id, selfieCapturedAt: user.selfieCapturedAt!.toISOString(), avatar, outcome: 'MATCH', docType: 'national_id', reason: 'synthetic fixture' },
  } });
}
