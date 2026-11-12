import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { scanUpload } from '../../lib/malware-scan';
import { recordUnscannedUpload } from '../../lib/upload-scan-debt';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { cleanStoredPhoto, looksLikeDocument } from '../../utils/images';
import { AppError } from '../../utils/errors';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import { liveDuplicateHolders } from './duplicate-holders';

/** How long an identical re-send counts as a retry of the same upload. */
export const UPLOAD_RETRY_WINDOW_MS = 10 * 60_000;

/** The document file types the store takes (POST /verification/upload), judged again by their bytes. */
export const DOCUMENT_UPLOAD_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/**
 * [#1449 S4-1] The same person's identical file (same bytes, same type), stored in the
 * last few minutes and not yet claimed by anything, IS the upload a lost reply hid: its
 * key is the answer. Anything already claimed (a document, a mover or recovery pointer)
 * or erased is never reused: a deliberate re-submission gets its own upload.
 */
export async function retriedUpload(
  db: FastifyInstance['prisma'], userId: string, sha256: string, mimeType: string, now = Date.now(),
): Promise<string | null> {
  const recent = await db.encryptedObject.findMany({
    where: { createdBy: userId, sha256, mimeType, shreddedAt: null, wrappedDek: { not: null }, createdAt: { gte: new Date(now - UPLOAD_RETRY_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' }, select: { fileKey: true }, take: 5,
  });
  for (const { fileKey } of recent) {
    const claimed = await db.verificationDocument.count({ where: { fileUrl: fileKey } })
      + await db.rider.count({ where: { OR: [{ nationalIdUrl: fileKey }, { driverLicenseUrl: fileKey }, { vehicleInsuranceUrl: fileKey }, { profilePhotoUrl: fileKey }, { vehiclePhotoUrl: fileKey }] } })
      + await db.driver.count({ where: { OR: [{ nationalIdUrl: fileKey }, { driverLicenseUrl: fileKey }, { vehicleInsuranceUrl: fileKey }, { vehicleInspectionUrl: fileKey }, { profilePhotoUrl: fileKey }, { vehiclePhotoUrl: fileKey }] } })
      + await db.accountRecovery.count({ where: { OR: [{ idDocumentUrl: fileKey }, { selfieUrl: fileKey }] } });
    if (claimed === 0) return fileKey;
  }
  return null;
}

/**
 * The ONE way a verification document's file is kept (POST /verification/upload, and the admin console's assisted setup
 * for a store, which files it for the store's account holder exactly as the store's own upload would): the type judged by
 * its bytes, a photo cleaned before it is sealed, scanned as plaintext, sealed with its own key and kept under the
 * account holder's own folder, owned by the account holder (object-authority.ts), so the document route claims it the
 * same way whoever pressed the button. Returns the storage key.
 */
export async function sealVerificationUpload(
  prisma: FastifyInstance['prisma'],
  notifications: NotificationService,
  input: { ownerUserId: string; buffer: Buffer; mimetype: string; log: FastifyBaseLogger },
): Promise<string> {
  const { ownerUserId, buffer, mimetype, log } = input;
  if (!DOCUMENT_UPLOAD_TYPES.has(mimetype)) {
    throw new AppError(400, 'BAD_TYPE', 'Only JPEG, PNG, WebP or PDF files are accepted');
  }
  // Magic-byte sniff (security spec §6): a spoofed Content-Type must not
  // smuggle an executable/HTML into the document store.
  if (!looksLikeDocument(buffer, mimetype)) {
    throw new AppError(400, 'BAD_CONTENT', 'File content does not match its declared format');
  }
  // [Row 108 · Row 238 · GUARDRAILS §2] The storage seam only ever sees this file ENCRYPTED, so the
  // photo is cleaned here, before it is sealed, by the seam's own helper: the metadata a phone camera
  // writes (GPS, capture time, device, serial) removed failing closed, then the clean bytes read by the
  // real decoder. What the bytes ARE decides it (a PDF passed the sniff above as a PDF: not a photo).
  const photo = await cleanStoredPhoto(buffer, mimetype);
  const sealedBytes = photo?.buffer ?? buffer;
  // The envelope records what is sealed: a photo's type is what its bytes are, as at the storage seam.
  const sealedType = photo?.mimeType ?? mimetype;
  // [Row 312] Scanned as plaintext, before it is encrypted: the store only ever sees ciphertext.
  const scan = await scanUpload(buffer, { surface: 'verification', log });
  const storage = getStorageProvider();

  // Envelope encryption (onboarding spec §5): with a KEK configured the
  // bucket only ever holds AES-256-GCM ciphertext; the wrapped per-file DEK
  // lands in encrypted_objects. Without it no ownership metadata can be
  // proved at submission, so refuse instead of handing back an unusable file.
  const keys = getKeyProvider();
  if (!keys) throw new AppError(503, 'VERIFICATION_UPLOAD_UNAVAILABLE', 'Document upload is temporarily unavailable. Try again later.');
  // The fingerprint of the file AS SUBMITTED: the duplicate-document and retry identity, comparable
  // with every row stored before [Row 238]. A one-way digest keeps nothing of the removed metadata.
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  // [#1449 S4-1] A retry after a lost reply sends the same file again: answer with the
  // upload already stored, so no second copy of an ID document is kept (and no second review signal).
  const retried = await retriedUpload(prisma, ownerUserId, sha256, sealedType);
  if (retried) return retried;
  // SWIFT-078: the SAME physical document already on ANOTHER account is a
  // fraud signal — one person opening several accounts, or a reused/forged
  // ID. Flag it to the reviewers; it must never quietly auto-progress.
  // [Row 331 (c)] Only a LIVE account counts: an erased one is never a duplicate holder.
  const dup = (await liveDuplicateHolders(prisma, sha256, ownerUserId)).length > 0;

  const dek = generateDek();
  const { ciphertext, iv, authTag } = encryptBuffer(sealedBytes, dek);
  const { url } = await storage.upload({
    buffer: ciphertext,
    // Multipart normalizes empty/path-only names to ''. Appending .enc
    // would then make a dotfile, which adapters name .bin. The envelope
    // extension is server-owned and must satisfy object authority.
    filename: 'verification.enc',
    mimeType: 'application/octet-stream',
    folder: `verification/${ownerUserId}`,
  });
  await prisma.encryptedObject.create({
    data: {
      fileKey: url,
      iv: new Uint8Array(iv),
      authTag: new Uint8Array(authTag),
      wrappedDek: new Uint8Array(await keys.wrapDek(dek)),
      mimeType: sealedType,
      sizeBytes: sealedBytes.length, // what is stored (and what a deletion receipt destroys)
      sha256,
      createdBy: ownerUserId,
    },
  });
  // [Row 312] Stored sealed: the rescan opens it with this key row (found by the same fileKey).
  await recordUnscannedUpload(prisma, scan, { surface: 'verification', fileKey: url, buffer, sealed: true, storage });

  if (dup) {
    await notifyAdmins(prisma, notifications, {
      // Global correlation is a platform review signal. Tenant-local
      // administrators and applicants must not learn another account's
      // membership, identifier, or document hash from upload completion.
      // notifyAdmins(null) selects SUPER_ADMIN only, never tenant admins.
      tenantId: null,
      title: 'Verification upload needs review',
      body: 'Review this applicant’s verification submission before approval.',
      data: { kind: 'dup_doc', uploader: ownerUserId },
    }).catch(() => {});
  }
  return url;
}
