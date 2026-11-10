import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { publishLegalDocumentOnce, recordConsent, type ConsentSurface } from '../legal/consent.service';
import type { VerificationService } from '../verification/verification.service';
import { OWN_NAME_DOC_TYPE } from '../verification/doc-registry';
import { OWN_NAME_CONSENT_TYPE, OWN_NAME_DECLARATION_V1, OWN_NAME_DECLARATION_VERSION, renderOwnNamePdf } from './own-name';

/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026] Signing and filing the own-name declaration, ONE implementation for its two
 * doors: the store's own-name choice (vendor.routes POST /onboarding/own-name, which also marks the store as trading
 * under the owner's own name at once) and [COMPANY-DOCS Part 3] a pending change of business type to "I trade under my
 * own name" (account-change.routes: the store is marked only when a person approves the change; the declaration is held
 * for the change by submitDocument). The words, their version and hash, the consent row, the PDF and its encryption are
 * the same either way.
 */
export async function fileOwnNameDeclaration(
  prisma: PrismaClient,
  verification: VerificationService,
  input: {
    userId: string;
    vendor: { id: string; name: string; vendorType: string };
    legalName: string;
    privacyNoticeVersion: string;
    surface: ConsentSurface;
    ip: string;
    /** Mark this store as trading under the owner's own name in the consent's transaction (the store's own choice). */
    markStore: boolean;
  },
) {
  const { userId, vendor } = input;
  // Acquire and wrap the key BEFORE publishing words, changing the store, or recording consent (as the declaration).
  const dek = generateDek();
  let wrappedDek: Buffer;
  try {
    const keys = getKeyProvider();
    if (!keys) throw new Error('Envelope encryption unavailable');
    wrappedDek = await keys.wrapDek(dek);
  } catch {
    throw new AppError(503, 'VERIFICATION_UPLOAD_UNAVAILABLE', 'Verification uploads are temporarily unavailable. Try again later.');
  }
  await publishLegalDocumentOnce(prisma, { documentType: OWN_NAME_CONSENT_TYPE, version: OWN_NAME_DECLARATION_VERSION, renderedText: OWN_NAME_DECLARATION_V1 });
  const signedAt = new Date();
  await prisma.$transaction(async (tx) => {
    // This store only: its name is the one checked, and the one the PDF and this consent row name.
    if (input.markStore) await tx.vendor.update({ where: { id: vendor.id }, data: { tradesUnderOwnName: true } });
    await recordConsent(tx, {
      subjectType: 'vendor_user', subjectId: userId, documentType: OWN_NAME_CONSENT_TYPE, version: OWN_NAME_DECLARATION_VERSION,
      action: 'granted', surface: input.surface, ip: input.ip,
      evidence: { vendorId: vendor.id, storeName: vendor.name, signedAt: signedAt.toISOString() },
    });
  });
  const pdf = await renderOwnNamePdf({ storeName: vendor.name, legalName: input.legalName, signedAt });
  const storage = getStorageProvider();
  const { ciphertext, iv, authTag } = encryptBuffer(pdf, dek);
  const { url: fileUrl } = await storage.upload({ buffer: ciphertext, filename: `own-name-${OWN_NAME_DECLARATION_VERSION}.pdf.enc`, mimeType: 'application/octet-stream', folder: `verification/${userId}` });
  await prisma.encryptedObject.create({ data: {
    fileKey: fileUrl, iv: new Uint8Array(iv), authTag: new Uint8Array(authTag), wrappedDek: new Uint8Array(wrappedDek),
    mimeType: 'application/pdf', sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), createdBy: userId,
  } });
  const role = vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE';
  return verification.submitDocument(userId, role, OWN_NAME_DOC_TYPE, fileUrl, input.privacyNoticeVersion, undefined, { ownNameSigned: true });
}
