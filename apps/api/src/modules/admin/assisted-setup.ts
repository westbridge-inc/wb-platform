import type { AssistedActionKind, AssistedConsentChannel, Prisma, PrismaClient, VendorType } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError, NotFoundError } from '../../utils/errors';
import { publishLegalDocumentOnce, recordConsent } from '../legal/consent.service';
import { UPLOAD_CONSENT, consentSubjectForRole } from '../verification/upload-consent';
import { POLICE_CLEARANCE_DOC_TYPE } from '../verification/doc-registry';

/**
 * [ASSISTED SETUP · owner 12 Nov 2026] "A Swift admin uploads a store's papers and menu for it from the console, with the
 * store's consent recorded (who agreed, how, when) and every action audited under the admin's name. Approving a paper the
 * same admin uploaded must be flagged (second-person approval when a second admin exists)."
 *
 * The admin acts FOR the store, never AS it: there is no session for the store, no login-as. Each action goes through the
 * store's own rules, unchanged:
 *  - a paper: kept by the store's own upload sealer (verification/upload-seal.ts) in the account holder's own folder and
 *    filed by the store's own filing (VerificationService.submitDocument): same checklist, same allow-lists, same
 *    engines. Only two things differ: the paper names its uploader and the consent (verification_documents.assistedById,
 *    assistedConsentId) and it always waits for a person. The store's document-processing tick is recorded in the
 *    consent ledger, as given through this consent record, with the very words the store's own box shows;
 *  - a menu: the store's own import (vendor/menu-import.ts) behind the store's own listing gate (listingAllowed): an
 *    unverified store still adds no new items, and the preview shows the row errors the store itself would see;
 *  - an item photo: the store's own photo keeping (keepPublicPhoto into `items/<store>/`) and setting (item-photo.ts).
 * The consent is recorded FIRST (assisted_setup_consents) and every action names it (assisted_setup_actions + the audit
 * trail, under the admin's own id). Never, by anyone else's hand: an own-name declaration or the food-handlers tick (the
 * filing refuses both: they are the owner's own signed words), a police clearance (its own consent, the person's own),
 * a VAT certificate (its own route).
 */

/** The capability: ADMIN and SUPER_ADMIN hold it by role default (`*`); a narrowed grant must name it. */
export const STORE_ASSIST_CAPABILITY = 'store.assist';

/** How long a store's recorded OK covers assisted actions, from when it was given. A new visit, a new OK. */
export const ASSISTED_CONSENT_VALID_DAYS = 14;

/** What a paper filed this way records as the privacy notice acknowledged (the website records 'web-v1'). */
export const ASSISTED_PRIVACY_NOTICE_VERSION = 'assisted-v1';

/** The consent words the admin reads to the store, exactly as the store's own upload box shows them. */
export const ASSISTED_DOCUMENT_CONSENT = UPLOAD_CONSENT.document_v1;

/**
 * What the admin asks before anything is recorded (console words, shown beside the consent text). Not a legal document:
 * the legal promise is the document-processing consent below, the store's own words.
 */
export const ASSISTED_SETUP_QUESTION =
  'May Swift add your store’s papers, menu and item photos to your Swift account for you? You can replace anything we add, at any time, in your Swift app or on the website.';

export const ASSISTED_CONSENT_CHANNELS = ['IN_PERSON', 'PHONE', 'WHATSAPP', 'EMAIL'] as const satisfies readonly AssistedConsentChannel[];

/** Never filed by Swift for a store: a police clearance carries its own consent, given by the person themselves. */
const NEVER_ASSISTED_DOC_TYPES: ReadonlySet<string> = new Set([POLICE_CLEARANCE_DOC_TYPE]);

export const consentInputSchema = z.object({
  agreedByName: z.string().trim().min(2).max(120),
  agreedByRole: z.string().trim().min(2).max(60),
  channel: z.enum(ASSISTED_CONSENT_CHANNELS),
  agreedAt: z.coerce.date(),
  reference: z.string().trim().min(1).max(120).optional(),
  /** The admin read the words to the store: these words (their version), not words from an older console. */
  wordsRead: z.literal(true),
  consentVersion: z.string().min(1).max(40),
  reason: z.string().optional(),
}).strict();
export type ConsentInput = z.infer<typeof consentInputSchema>;

export interface AssistStore {
  id: string;
  name: string;
  tenantId: string;
  vendorType: VendorType;
  status: string;
  holderId: string;
}

/** The store the admin acts for, read through the admin's tenant wall (another market's store: not found). */
export async function storeForAssist(db: PrismaClient, vendorId: string): Promise<AssistStore> {
  const store = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, name: true, tenantId: true, vendorType: true, status: true, owner: { select: { userId: true, user: { select: { status: true } } } } },
  });
  if (!store) throw new NotFoundError('Vendor', vendorId);
  if (['DEACTIVATED', 'BANNED'].includes(store.owner.user.status)) {
    throw new AppError(409, 'ACCOUNT_INACTIVE', 'This store’s account is closed. Nothing can be added for it.');
  }
  return { id: store.id, name: store.name, tenantId: store.tenantId, vendorType: store.vendorType, status: store.status, holderId: store.owner.userId };
}

export function consentStillLive(consent: { agreedAt: Date }, now = new Date()): boolean {
  return now.getTime() - consent.agreedAt.getTime() <= ASSISTED_CONSENT_VALID_DAYS * 86_400_000;
}

/**
 * The consent an action is done under: given for THIS store, by its CURRENT account holder's store, and still within
 * its days. Anything else: nothing happens (409), and the console asks for the store's OK again.
 */
export async function liveConsent(db: PrismaClient | Prisma.TransactionClient, store: AssistStore, consentId: string | undefined, now = new Date()) {
  if (!consentId) throw consentRequired();
  const consent = await db.assistedSetupConsent.findFirst({ where: { id: consentId, vendorId: store.id } });
  if (!consent || consent.holderId !== store.holderId || !consentStillLive(consent, now)) throw consentRequired();
  return consent;
}

export function consentRequired(): AppError {
  return new AppError(409, 'ASSISTED_CONSENT_REQUIRED',
    `Record the store’s OK first (who agreed, how and when). An OK covers ${ASSISTED_CONSENT_VALID_DAYS} days.`);
}

/**
 * Records the store's OK: the consent row, and the audit row through `audit`, in one transaction. The time it was given
 * may not be in the future, nor older than the days an OK covers.
 */
export async function recordAssistedConsent(
  prisma: PrismaClient,
  input: { store: AssistStore; adminId: string; body: ConsentInput; reason: string; audit: (tx: Prisma.TransactionClient, consentId: string) => Promise<void> },
  now = new Date(),
) {
  const { store, body } = input;
  if (body.consentVersion !== ASSISTED_DOCUMENT_CONSENT.version) {
    throw new AppError(409, 'CONSENT_WORDS_CHANGED', 'The consent words have changed. Reload the page, read the new words to the store and record its OK again.');
  }
  if (body.agreedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new AppError(400, 'AGREED_IN_FUTURE', 'The time the store agreed cannot be in the future.');
  }
  if (!consentStillLive({ agreedAt: body.agreedAt }, now)) {
    throw new AppError(400, 'AGREED_TOO_LONG_AGO', `An OK covers ${ASSISTED_CONSENT_VALID_DAYS} days. Ask the store again and record the new OK.`);
  }
  return prisma.$transaction(async (tx) => {
    const consent = await tx.assistedSetupConsent.create({
      data: {
        tenantId: store.tenantId,
        vendorId: store.id,
        holderId: store.holderId,
        agreedByName: body.agreedByName,
        agreedByRole: body.agreedByRole,
        channel: body.channel,
        agreedAt: body.agreedAt,
        reference: body.reference ?? null,
        consentDocumentType: ASSISTED_DOCUMENT_CONSENT.documentType,
        consentVersion: ASSISTED_DOCUMENT_CONSENT.version,
        recordedByAdminId: input.adminId,
        reason: input.reason,
      },
    });
    await input.audit(tx, consent.id);
    return consent;
  });
}

/** A doc type Swift may file for this store: on its checklist or its optional list, and never one that carries its own consent. */
export function assertAssistableDocType(docType: string, lists: { checklist: readonly string[]; optional: readonly string[] }): void {
  if (NEVER_ASSISTED_DOC_TYPES.has(docType)) {
    throw new AppError(400, 'NOT_ASSISTED_DOC_TYPE', 'A police clearance has its own consent: the person sends it themselves, in the Swift app or on the website.');
  }
  if (!lists.checklist.includes(docType) && !lists.optional.includes(docType)) {
    throw new AppError(400, 'INVALID_DOC_TYPE', 'This paper is not on the store’s list.');
  }
}

/**
 * Inside the filing's transaction: the store's document-processing tick, recorded in the consent ledger as given through
 * the consent record (the same words, version and hash the store's own box shows, so the store's checklist shows its
 * tick as on record), the action row, and the audit row.
 */
export async function recordAssistedFiling(
  tx: Prisma.TransactionClient,
  input: { store: AssistStore; consentId: string; channel: AssistedConsentChannel; adminId: string; docId: string; docType: string; ip: string | null },
): Promise<void> {
  await recordConsent(tx, {
    subjectType: consentSubjectForRole(input.store.vendorType),
    subjectId: input.store.holderId,
    documentType: ASSISTED_DOCUMENT_CONSENT.documentType,
    version: ASSISTED_DOCUMENT_CONSENT.version,
    action: 'granted',
    surface: 'admin',
    ip: input.ip,
    evidence: {
      control: 'assisted_setup_consent', path: 'admin/assisted-setup', docType: input.docType,
      assistedConsentId: input.consentId, channel: input.channel, recordedBy: input.adminId,
    },
  });
  await recordAction(tx, { store: input.store, consentId: input.consentId, adminId: input.adminId, kind: 'DOCUMENT', targetId: input.docId, detail: input.docType });
}

/** The words exist as a published version before any tick names them (consent ledger anchor). */
export async function publishAssistedConsentWords(prisma: PrismaClient): Promise<void> {
  await publishLegalDocumentOnce(prisma, {
    documentType: ASSISTED_DOCUMENT_CONSENT.documentType, version: ASSISTED_DOCUMENT_CONSENT.version, renderedText: ASSISTED_DOCUMENT_CONSENT.text,
  });
}

export async function recordAction(
  tx: Prisma.TransactionClient,
  input: { store: AssistStore; consentId: string; adminId: string; kind: AssistedActionKind; targetId: string; detail?: string | null },
): Promise<void> {
  await tx.assistedSetupAction.create({
    data: {
      tenantId: input.store.tenantId, vendorId: input.store.id, consentId: input.consentId, adminId: input.adminId,
      kind: input.kind, targetId: input.targetId, detail: input.detail ?? null,
    },
  });
}

export interface AssistedItemMarks { addedBySwiftAt?: string; photoAddedBySwiftAt?: string }

/**
 * [ASSISTED SETUP] What the store's menu shows on an item Swift added for it: "Added by Swift on <date> with your OK"
 * (the item came from an assisted import), and the same for its photo while it is still the photo Swift added (a photo
 * the store replaced is the store's own). Never who at Swift.
 */
export async function assistedItemMarks(
  db: PrismaClient | Prisma.TransactionClient,
  vendorIds: readonly string[],
  items: ReadonlyArray<{ id: string; imageUrl?: string | null }>,
): Promise<Map<string, AssistedItemMarks>> {
  const marks = new Map<string, AssistedItemMarks>();
  if (items.length === 0 || vendorIds.length === 0) return marks;
  const actions = await db.assistedSetupAction.findMany({
    where: { vendorId: { in: [...vendorIds] }, kind: { in: ['MENU_ITEM', 'ITEM_PHOTO'] }, targetId: { in: items.map((i) => i.id) } },
    select: { kind: true, targetId: true, detail: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const photoOf = new Map(items.map((i) => [i.id, i.imageUrl ?? null]));
  for (const a of actions) {
    const mark = marks.get(a.targetId) ?? {};
    if (a.kind === 'MENU_ITEM') mark.addedBySwiftAt ??= a.createdAt.toISOString();
    if (a.kind === 'ITEM_PHOTO' && a.detail && photoOf.get(a.targetId) === a.detail) mark.photoAddedBySwiftAt = a.createdAt.toISOString();
    if (mark.addedBySwiftAt || mark.photoAddedBySwiftAt) marks.set(a.targetId, mark);
  }
  return marks;
}

/** The consent rows the console lists (newest first), each saying whether it still covers actions. */
export async function consentsOf(db: PrismaClient, store: AssistStore, now = new Date()) {
  const rows = await db.assistedSetupConsent.findMany({
    where: { vendorId: store.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, holderId: true, agreedByName: true, agreedByRole: true, channel: true, agreedAt: true, reference: true, recordedByAdminId: true, createdAt: true },
  });
  return rows.map(({ holderId, ...row }) => ({ ...row, live: holderId === store.holderId && consentStillLive(row, now) }));
}
