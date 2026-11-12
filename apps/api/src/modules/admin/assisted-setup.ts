import type { AssistedActionKind, AssistedAgreedAs, AssistedConsentChannel, Prisma, PrismaClient, VendorType } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError, NotFoundError } from '../../utils/errors';
import { UPLOAD_CONSENT } from '../verification/upload-consent';
import { BUCKET_OF, FOOD_HANDLER_ATTESTATION_TYPE, OWN_NAME_DOC_TYPE, POLICE_CLEARANCE_DOC_TYPE } from '../verification/doc-registry';
import { VAT_CERTIFICATE_DOC_TYPE } from '../store-vat/store-vat';
import { isDocumentValidAt } from '../verification/document-validity';

/** The filing's renewal window (verification.service REMINDER_WINDOW_DAYS): a current paper reopens 30 days before it lapses. */
const RENEWAL_WINDOW_DAYS = 30;

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

export const ASSISTED_AGREED_AS = ['ACCOUNT_HOLDER', 'MANAGER'] as const satisfies readonly AssistedAgreedAs[];

/**
 * [#2495 review B S2-1] Never filed by Swift for a store, refused BEFORE anything is stored: what the store signs, ticks
 * or consents to itself. A police clearance carries its own consent, given by the person; the own-name declaration and
 * the food-handlers tick are the owner's own signed words; the VAT certificate has its own route and a person's decision.
 * The panel draws these as "The store does this itself", with no upload.
 */
export const NEVER_ASSISTED_DOC_TYPES: ReadonlySet<string> = new Set([
  POLICE_CLEARANCE_DOC_TYPE, OWN_NAME_DOC_TYPE, FOOD_HANDLER_ATTESTATION_TYPE, VAT_CERTIFICATE_DOC_TYPE,
]);

/**
 * [#2495 review A S2-1 / B S3-3 · COORD ruling 12 Nov 2026] A paper that is a PERSON's own (an ID, a personal licence: the
 * registry's PERSONAL bucket; an unknown type counts as PERSONAL, the most careful reading) is filed by Swift only on an
 * OK the account holder gave themself. Business papers may be OK'd by the holder or a manager.
 */
export function isPersonalPaper(docType: string): boolean {
  return (BUCKET_OF[docType] ?? 'PERSONAL') === 'PERSONAL';
}

export const consentInputSchema = z.object({
  agreedByName: z.string().trim().min(2).max(120),
  /** Who said yes, as a choice: the account holder themself, or a manager at the store. Never free text. */
  agreedAs: z.enum(ASSISTED_AGREED_AS),
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
  holderStatus: string;
}

/** [#2495 review B S2-1] A suspended account holder takes no new paper (the filing would refuse it): refused before the
 *  file is stored. */
export function assertHolderTakesPapers(store: AssistStore): void {
  if (store.holderStatus === 'SUSPENDED') {
    throw new AppError(409, 'ACCOUNT_INACTIVE', 'This store’s account is suspended. No paper can be added for it until it is reinstated.');
  }
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
  return { id: store.id, name: store.name, tenantId: store.tenantId, vendorType: store.vendorType, status: store.status, holderId: store.owner.userId, holderStatus: store.owner.user.status };
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
        agreedAs: body.agreedAs,
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

/** A doc type Swift may file for this store, under this OK, checked before anything is stored: not one the store signs,
 *  ticks or consents to itself; on the store's checklist or optional list; a person's own paper only on the account
 *  holder's own OK; and not one already approved and current beyond its renewal window (the filing would refuse it). */
export function assertAssistableDocType(
  docType: string,
  lists: { checklist: readonly string[]; optional: readonly string[]; documents?: ReadonlyArray<{ docType: string; status: string; expiresAt: Date | string | null }> },
  consent: { agreedAs: AssistedAgreedAs },
  now = new Date(),
): void {
  if (NEVER_ASSISTED_DOC_TYPES.has(docType)) {
    throw new AppError(400, 'NOT_ASSISTED_DOC_TYPE', 'The store does this itself, in the Swift app or on the website: it signs, ticks or consents to it there. Swift cannot add it for the store.');
  }
  if (!lists.checklist.includes(docType) && !lists.optional.includes(docType)) {
    throw new AppError(400, 'INVALID_DOC_TYPE', 'This paper is not on the store’s list.');
  }
  if (isPersonalPaper(docType) && consent.agreedAs !== 'ACCOUNT_HOLDER') {
    throw new AppError(403, 'ASSISTED_PERSONAL_PAPER_NEEDS_HOLDER',
      'This paper is a person’s own (an ID or a personal licence). Swift adds it only with the account holder’s own OK. Record an OK from the account holder first.');
  }
  const renewalOpensAt = new Date(now.getTime() + RENEWAL_WINDOW_DAYS * 86_400_000);
  const current = lists.documents?.find((d) => d.docType === docType && d.status === 'APPROVED'
    && isDocumentValidAt(d.expiresAt == null ? null : new Date(d.expiresAt), renewalOpensAt));
  if (current) throw new AppError(409, 'ALREADY_APPROVED', 'The store’s copy of this paper is approved and current. A renewal opens 30 days before it expires.');
}

/** Inside the filing's transaction: the action row (the audit row is the caller's). [#2495 review A S2-1 · COORD ruling]
 *  Never a row in the consent ledger: the account holder's own document-consent box is theirs to tick. The OK is
 *  recorded under the assisted OK only (assisted_setup_consents, 14 days, that store and holder). */
export async function recordAssistedFiling(
  tx: Prisma.TransactionClient,
  input: { store: AssistStore; consentId: string; adminId: string; docId: string; docType: string },
): Promise<void> {
  await recordAction(tx, { store: input.store, consentId: input.consentId, adminId: input.adminId, kind: 'DOCUMENT', targetId: input.docId, detail: input.docType });
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
    select: { id: true, holderId: true, agreedByName: true, agreedAs: true, channel: true, agreedAt: true, reference: true, recordedByAdminId: true, createdAt: true },
  });
  return rows.map(({ holderId, ...row }) => ({ ...row, live: holderId === store.holderId && consentStillLive(row, now) }));
}
