/**
 * [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 ~07:3xZ (c) + (d)] Changing who a store account is, with a person at
 * Swift deciding.
 *
 * (c) "Change business type" (Account, phone + web). A store that chose wrongly at sign-up (e.g. a registered company
 *     marked as trading under its owner's own name) picks the right answer — a registered company, a registered business,
 *     its manager, or a trader under their own name — and uploads that answer's papers (Part 1's checklist for it). A
 *     person at Swift checks each paper and then the change. The store KEEPS SELLING on its old checked papers meanwhile.
 *     Approved: the account's choice, the papers that count, and the seller name customers see switch in ONE
 *     transaction. Refused: nothing changes, and the store sees why.
 * (d) Account-holder handover (a company's account, or a manager's). The holder names the new person (their own Swift
 *     account); the new person says yes in their own app and files their own papers (their ID, the new letter of
 *     authority naming them, and the account's other papers: Swift keeps papers per person). A person at Swift checks
 *     them and the handover; on approval the account moves to the new person for ALL branches and the old person loses
 *     access (every session ends, their store role goes). Refused or withdrawn: nothing changes. Neither person can take
 *     or keep the account without a person's approval.
 *
 * How "keeps selling" and "switches atomically" hold (one rule each, nothing scattered):
 *  - A paper filed for a pending change carries `accountChangeId` (VerificationDocument; set when filed, never moved).
 *    It counts for NOTHING (evidence.ts liveSubmissionWhere: the go-live gate, the expiry bound, the storefront's
 *    supplier block) until its change is APPROVED. So the gates read the old papers until the decision, and the new ones
 *    from the decision, with no window in between. Only papers the account does not already use are filed this way
 *    (`changePaperStaging`); a paper both answers use stays an ordinary paper.
 *  - The decision (`approveAccountChange`) runs in the verification service's projection transaction: the change row,
 *    the account's choice or holder, the seller names, and the activation projection commit together, or none of it.
 *    Every store that passed its papers before must pass them after, or the approval is refused and nothing moves.
 *  - A refusal or withdrawal (`endAccountChange`) closes the papers filed for it (waiting ones leave review; approved
 *    ones are withdrawn), so nothing of a refused change can ever count.
 *  - One PENDING change per account, and one per person named (partial unique indexes); a decided row is final (trigger).
 *  - The seller's legal name (#2476) typed from a paper filed for the change is HELD on the change until the decision
 *    (`holdChangeLegalName`); approved, it becomes the account's, and with none held the account's old one is cleared
 *    (`settleSellerLegalName`): a name typed for the old business type or holder never names the new one.
 * Open orders are never touched: nothing here writes an order, and a handover moves the account, not the stores.
 */
import type { AccountChangeRequest, BusinessTypeOption, Prisma, PrismaClient, VendorAccountBasis } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { insertNoticeFor } from '../../lib/owner-wall-notices';
import { bindTenantTransaction } from '../../plugins/prisma';
import { lockIdentityAuthority } from '../integrity/identity-review';
import { VENDOR_MMG_DESTINATION_CLEARED } from '../../utils/store-mmg';
import { closeOpenMmgStagesFor } from '../integrity/money-surface';
import { CountryConfigService } from '../country/country-config.service';
import { recordEvidenceFor } from '../verification/evidence';
import { hopDocState } from '../verification/doc-state';
import { ACCOUNT_HOLDER_ID_DOC_TYPE, BUCKET_OF, OWN_NAME_TIER } from '../verification/doc-registry';
import { revokeAllSessionsInTransaction } from '../auth/session-revocation';
import type { MoverSessionRevocationCleanup } from '../mover-authority';
import { accountBasisApplies, accountTierOf, type AccountBasis } from './account-basis';
import { OWN_NAME_VENDOR_TYPES, storeNameIsOwnName } from './own-name';
import { validRegistrationRecord } from './registration-record';
import { SELLER_NAME_UNCONFIRMED } from '../verification/storefront-disclosure';
import { isAccountPersonsName, SELLER_NAME_IS_A_PERSON_NOTICE } from '../verification/verification.service';

type Db = Prisma.TransactionClient | PrismaClient;

export const BUSINESS_TYPE_OPTIONS = ['COMPANY', 'REGISTERED', 'MANAGER', 'OWN_NAME'] as const satisfies readonly BusinessTypeOption[];

/** The store kinds a person signs up as a store account (a service PROVIDER is not one). */
export const STORE_ACCOUNT_ROLES: ReadonlySet<string> = new Set(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']);

/** How long a holder waits between handover requests they start (a cap on naming numbers, one at a time anyway). */
const HANDOVER_STARTS_PER_DAY = 3;
/** [review-2475 F8] Every try at naming someone, named or not, counts here: a holder learns at most this many numbers'
 *  answers a day. */
const HANDOVER_TRIES_PER_DAY = 5;
/** [review-2475 F8] Asks for a business type a day (an ask -> withdraw -> ask loop pages every reviewer each time). */
const BUSINESS_TYPE_ASKS_PER_DAY = 3;

/** What an answer makes the account: its basis, and whether its stores trade under the owner's own name. */
export interface AccountShape { basis: AccountBasis; ownName: boolean }

export function shapeOf(option: BusinessTypeOption): AccountShape {
  switch (option) {
    case 'COMPANY': return { basis: 'COMPANY', ownName: false };
    case 'MANAGER': return { basis: 'MANAGER', ownName: false };
    case 'OWN_NAME': return { basis: 'OWNER', ownName: true };
    case 'REGISTERED': return { basis: 'OWNER', ownName: false };
  }
}

const ownNameKind = (vendorType: string): boolean => (OWN_NAME_VENDOR_TYPES as readonly string[]).includes(vendorType);

interface StoreRow { id: string; name: string; vendorType: string; tradesUnderOwnName: boolean }

/** The account's answer today. A business owner's account is OWN_NAME only while every store that could trade under
 *  the owner's own name does; otherwise REGISTERED. */
export function currentOptionOf(owner: { accountBasis: VendorAccountBasis; vendors: readonly Pick<StoreRow, 'vendorType' | 'tradesUnderOwnName'>[] }): BusinessTypeOption {
  if (owner.accountBasis === 'COMPANY') return 'COMPANY';
  if (owner.accountBasis === 'MANAGER') return 'MANAGER';
  const ownNameStores = owner.vendors.filter((v) => ownNameKind(v.vendorType));
  return ownNameStores.length > 0 && ownNameStores.every((v) => v.tradesUnderOwnName) ? 'OWN_NAME' : 'REGISTERED';
}

/** The checklist tier ONE store reads under a shape: the account's company or manager list, the own-name list for a
 *  store that trades under the owner's own name, else the standard list (verification.service vendorTierOf). */
export function tierUnder(shape: AccountShape, store: Pick<StoreRow, 'vendorType'>, ownName: boolean): string | undefined {
  return accountTierOf(shape.basis, store.vendorType) ?? (ownName && ownNameKind(store.vendorType) ? OWN_NAME_TIER : undefined);
}

/** Each store's list today (its own flag) and under a target shape (the target's flag for every store). */
async function storeLists(
  db: Db, countryCode: string, basis: AccountBasis, stores: readonly StoreRow[], target?: AccountShape,
): Promise<Map<string, string[]>> {
  const config = new CountryConfigService(db as PrismaClient);
  const out = new Map<string, string[]>();
  for (const store of stores) {
    const tier = target ? tierUnder(target, store, target.ownName) : tierUnder({ basis, ownName: false }, store, store.tradesUnderOwnName);
    out.set(store.id, await config.getDocumentChecklist(countryCode, store.vendorType, tier, db));
  }
  return out;
}

const unionOf = (lists: Iterable<string[]>): string[] => [...new Set([...lists].flat())];

// ---------------------------------------------------------------------------------------------------------------------
// Which papers a pending change takes (submitDocument's hook)
// ---------------------------------------------------------------------------------------------------------------------

export interface ChangeStaging {
  changeId: string;
  /** Types this person may file for the store role because of the change. */
  submittable: string[];
  /** Is a paper of this type filed FOR the change (counts only once it is approved)? */
  stages(docType: string): boolean;
}

/**
 * [Part 2 seam] The ONE hook the document path calls (VerificationService.submitDocument): whatever files a paper — the
 * upload screens, or Part 2's in-app signed letter — files it through submitDocument, so a letter for a pending change
 * is held for that change with no extra wiring.
 *  - A pending business-type change of the account this person holds: the new answer's papers that the account does
 *    not already use are filed for the change.
 *  - A pending handover naming this person, which they accepted: every paper the account's stores use is theirs to file,
 *    for the handover.
 * Null: no change is waiting for this person's papers.
 */
export async function changePaperStaging(db: Db, userId: string, roleKey: string, countryCode: string): Promise<ChangeStaging | null> {
  if (!STORE_ACCOUNT_ROLES.has(roleKey)) return null;
  const owner = await db.vendorOwner.findUnique({
    where: { userId },
    select: { id: true, accountBasis: true, vendors: { select: { id: true, name: true, vendorType: true, tradesUnderOwnName: true } } },
  });
  if (owner) {
    const change = await db.accountChangeRequest.findFirst({ where: { vendorOwnerId: owner.id, status: 'PENDING', kind: 'BUSINESS_TYPE' }, select: { id: true, toOption: true } });
    if (!change?.toOption) return null;
    const ofRole = owner.vendors.filter((v) => v.vendorType === roleKey);
    if (ofRole.length === 0) return null;
    const target = unionOf((await storeLists(db, countryCode, owner.accountBasis, ofRole, shapeOf(change.toOption))).values());
    const current = new Set(unionOf((await storeLists(db, countryCode, owner.accountBasis, owner.vendors)).values()));
    return { changeId: change.id, submittable: target, stages: (docType) => target.includes(docType) && !current.has(docType) };
  }
  const handover = await db.accountChangeRequest.findFirst({
    where: { newHolderId: userId, status: 'PENDING', kind: 'HOLDER_HANDOVER', newHolderAcceptedAt: { not: null } },
    select: { id: true, vendorOwner: { select: { accountBasis: true, vendors: { select: { id: true, name: true, vendorType: true, tradesUnderOwnName: true } } } } },
  });
  if (!handover) return null;
  const ofRole = handover.vendorOwner.vendors.filter((v) => v.vendorType === roleKey);
  if (ofRole.length === 0) return null;
  const list = unionOf((await storeLists(db, countryCode, handover.vendorOwner.accountBasis, ofRole)).values());
  return { changeId: handover.id, submittable: list, stages: (docType) => list.includes(docType) };
}

/** Under the person's lock, in the filing transaction: a paper is filed for a change only while it still waits. */
export async function assertChangeTakesPapers(tx: Prisma.TransactionClient, changeId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS status FROM "account_change_requests" WHERE "id" = ${changeId} FOR SHARE /* account-change-paper */`;
  if (rows[0]?.status !== 'PENDING') {
    throw new AppError(409, 'ACCOUNT_CHANGE_DECIDED', 'That change has already been decided. Open Account to see where it stands.');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a change: its papers, item by item
// ---------------------------------------------------------------------------------------------------------------------

export type ChangePaperState = 'APPROVED' | 'PENDING' | 'REJECTED' | 'MISSING';
export interface ChangePaper {
  docType: string;
  state: ChangePaperState;
  /** The reviewer's words on a refused paper (the store's own copy only). */
  note: string | null;
  /** Filed for this change (counts only when it is approved), or a paper the account already uses. */
  forChange: boolean;
  /** The latest paper of the type (its review in the console's Documents queue). */
  documentId: string | null;
  /** The store kind to file it under (POST /verification/documents `role`): a store of the account whose list asks for it. */
  role: string;
}
export interface ChangeView {
  id: string;
  kind: AccountChangeRequest['kind'];
  status: AccountChangeRequest['status'];
  fromOption: BusinessTypeOption | null;
  toOption: BusinessTypeOption | null;
  createdAt: string;
  decidedAt: string | null;
  /** Shown to the store (and the person named) on a refusal only. */
  refusalReason: string | null;
  /** HOLDER_HANDOVER: has the person named said yes? */
  accepted: boolean | null;
  /** Whose papers the list reads: the account holder's (c), or the person named (d). */
  papers: ChangePaper[];
  /** Every paper is approved: the change only waits for a person's decision. */
  papersComplete: boolean;
}

const CHANGE_SELECT = {
  id: true, tenantId: true, kind: true, status: true, fromOption: true, toOption: true, holderId: true, newHolderId: true,
  newHolderAcceptedAt: true, requestedById: true, decidedAt: true, decidedById: true, decisionReason: true, createdAt: true,
  vendorOwner: { select: { id: true, userId: true, accountBasis: true, vendors: { select: { id: true, name: true, vendorType: true, tradesUnderOwnName: true }, orderBy: { createdAt: 'asc' } } } },
} satisfies Prisma.AccountChangeRequestSelect;
type ChangeRow = Prisma.AccountChangeRequestGetPayload<{ select: typeof CHANGE_SELECT }>;

/** The person whose papers a change reads, and the list they must hold. */
async function changeRequirement(db: Db, change: ChangeRow): Promise<{ paperHolderId: string; list: string[]; perStore: Map<string, string[]> }> {
  const paperHolderId = change.kind === 'HOLDER_HANDOVER' ? change.newHolderId! : change.vendorOwner.userId;
  const holder = await db.user.findUniqueOrThrow({ where: { id: change.vendorOwner.userId }, select: { countryCode: true } });
  const perStore = await storeLists(db, holder.countryCode, change.vendorOwner.accountBasis, change.vendorOwner.vendors,
    change.kind === 'BUSINESS_TYPE' && change.toOption ? shapeOf(change.toOption) : undefined);
  return { paperHolderId, list: unionOf(perStore.values()), perStore };
}

async function readChangePapers(db: Db, change: ChangeRow, now = new Date()): Promise<{ papers: ChangePaper[]; complete: boolean; perStore: Map<string, string[]>; paperHolderId: string }> {
  const { paperHolderId, list, perStore } = await changeRequirement(db, change);
  // [review-2475 F1] A handover's papers are the person named's OWN papers filed FOR THIS handover: a paper they hold from
  // another account (a company they held before) names that other business, and never counts for this one.
  const handover = change.kind === 'HOLDER_HANDOVER';
  const counting = handover ? { onlyChange: change.id, withChange: change.id } : change.status === 'PENDING' ? { withChange: change.id } : {};
  const approved = new Set((await recordEvidenceFor(db, paperHolderId, list, now, counting)).map((r) => r.docType));
  const filed = await db.verificationDocument.findMany({
    where: { userId: paperHolderId, docType: { in: list }, ...(handover ? { accountChangeId: change.id } : { OR: [{ accountChangeId: null }, { accountChangeId: change.id }] }) },
    orderBy: { createdAt: 'desc' },
    select: { id: true, docType: true, status: true, state: true, reviewNote: true, accountChangeId: true },
  });
  const papers = list.map((docType): ChangePaper => {
    const latest = filed.find((d) => d.docType === docType && d.state !== 'SUPERSEDED') ?? null;
    const state: ChangePaperState = approved.has(docType) ? 'APPROVED'
      : latest?.status === 'PENDING' ? 'PENDING'
        : latest?.status === 'REJECTED' ? 'REJECTED' : 'MISSING';
    const askedBy = change.vendorOwner.vendors.find((v) => perStore.get(v.id)?.includes(docType));
    return {
      docType, state, note: state === 'REJECTED' ? latest?.reviewNote ?? null : null,
      forChange: latest?.accountChangeId === change.id || change.kind === 'HOLDER_HANDOVER', documentId: latest?.id ?? null,
      role: String(askedBy?.vendorType ?? change.vendorOwner.vendors[0]?.vendorType ?? 'STORE'),
    };
  });
  return { papers, complete: papers.every((p) => p.state === 'APPROVED'), perStore, paperHolderId };
}

/**
 * [review-2475 F3] A handover's papers are the person named's: the account holder sees how far each one got, never a
 * reviewer's note on it or its document id (a refusal note is about a third person). The person named and the console
 * pass `paperDetails`.
 */
export async function viewOfChange(db: Db, change: ChangeRow, opts: { paperDetails?: boolean } = {}): Promise<ChangeView> {
  const read = change.status === 'PENDING' || change.status === 'APPROVED'
    ? await readChangePapers(db, change) : { papers: [], complete: false };
  const complete = read.complete;
  const papers = change.kind === 'HOLDER_HANDOVER' && !opts.paperDetails
    ? read.papers.map((p) => ({ ...p, note: null, documentId: null })) : read.papers;
  return {
    id: change.id, kind: change.kind, status: change.status, fromOption: change.fromOption, toOption: change.toOption,
    createdAt: change.createdAt.toISOString(), decidedAt: change.decidedAt?.toISOString() ?? null,
    refusalReason: change.status === 'REFUSED' ? change.decisionReason : null,
    accepted: change.kind === 'HOLDER_HANDOVER' ? change.newHolderAcceptedAt !== null : null,
    papers, papersComplete: complete,
  };
}

export async function loadChange(db: Db, changeId: string): Promise<ChangeRow> {
  const change = await db.accountChangeRequest.findUnique({ where: { id: changeId }, select: CHANGE_SELECT });
  if (!change) throw new NotFoundError('AccountChange', changeId);
  return change;
}

/** The account holder's view: the change waiting (or the last one decided), and what they may ask for. */
export async function holderAccountChange(db: Db, userId: string): Promise<{
  current: BusinessTypeOption; options: BusinessTypeOption[]; handoverOpen: boolean; change: ChangeView | null;
}> {
  const owner = await db.vendorOwner.findUnique({
    where: { userId }, select: { id: true, accountBasis: true, vendors: { select: { id: true, name: true, vendorType: true, tradesUnderOwnName: true } } },
  });
  if (!owner || owner.vendors.length === 0) throw new AppError(403, 'STAFF_FORBIDDEN', 'Only the account holder can change the business type');
  const current = currentOptionOf(owner);
  const options = BUSINESS_TYPE_OPTIONS.filter((option) => option !== current
    && owner.vendors.every((v) => accountBasisApplies(shapeOf(option).basis, v.vendorType))
    && (option !== 'OWN_NAME' || owner.vendors.some((v) => ownNameKind(v.vendorType))));
  const latest = await db.accountChangeRequest.findFirst({ where: { vendorOwnerId: owner.id, requestedById: userId }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, decidedAt: true } });
  // A decided change stays on screen for a week (the store sees the answer and, on a refusal, why).
  const shown = latest && (latest.status === 'PENDING' || (latest.decidedAt && Date.now() - latest.decidedAt.getTime() < 7 * 86_400_000)) ? latest : null;
  return {
    current, options, handoverOpen: owner.accountBasis === 'COMPANY' || owner.accountBasis === 'MANAGER',
    change: shown ? await viewOfChange(db, await loadChange(db, shown.id)) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------------------------------------------------

function onePending(error: unknown): never {
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
    throw new AppError(409, 'ACCOUNT_CHANGE_PENDING', 'A change to this account is already waiting for Swift. Withdraw it first, or wait for the answer.');
  }
  throw error;
}

/**
 * (c) The account holder asks to change the business type. Refused with the reason in words when the answer is the
 * one the account already has, when a store's kind cannot take it, or (own name) when a store's name is not the owner's
 * own name or a registration is on file — the same rules sign-up and the own-name route apply.
 */
export async function startBusinessTypeChange(prisma: PrismaClient, userId: string, toOption: BusinessTypeOption): Promise<ChangeView> {
  const owner = await prisma.vendorOwner.findUnique({
    where: { userId },
    select: { id: true, accountBasis: true, user: { select: { tenantId: true, firstName: true, lastName: true, status: true } }, vendors: { select: { id: true, name: true, vendorType: true, tradesUnderOwnName: true } } },
  });
  if (!owner || owner.vendors.length === 0) throw new AppError(403, 'STAFF_FORBIDDEN', 'Only the account holder can change the business type');
  if (owner.user.status !== 'ACTIVE') throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
  const since = new Date(Date.now() - 86_400_000);
  if (await prisma.accountChangeRequest.count({ where: { vendorOwnerId: owner.id, kind: 'BUSINESS_TYPE', createdAt: { gt: since } } }) >= BUSINESS_TYPE_ASKS_PER_DAY) {
    throw new AppError(429, 'BUSINESS_TYPE_DAILY_LIMIT', 'You can ask to change your business type up to 3 times a day. Try again tomorrow.');
  }
  const fromOption = currentOptionOf(owner);
  const target = shapeOf(toOption);
  const unchanged = target.basis === owner.accountBasis
    && owner.vendors.filter((v) => ownNameKind(v.vendorType)).every((v) => v.tradesUnderOwnName === target.ownName);
  if (unchanged) throw new AppError(409, 'NOTHING_TO_CHANGE', 'Your account already has that business type.');
  for (const store of owner.vendors) {
    if (!accountBasisApplies(target.basis, store.vendorType)) {
      throw new AppError(400, 'ACCOUNT_BASIS_NOT_APPLICABLE', target.basis === 'MANAGER'
        ? 'A manager can hold a registered restaurant, supermarket or store. A service business stays on its owner’s own account.'
        : 'One of your stores is a kind of business that can’t be held that way.');
    }
  }
  if (toOption === 'OWN_NAME') {
    const ownNameStores = owner.vendors.filter((v) => ownNameKind(v.vendorType));
    if (ownNameStores.length === 0) throw new AppError(400, 'OWN_NAME_NOT_APPLICABLE', 'A service business is not asked for a business registration, so it trades as it is.');
    const misfit = ownNameStores.find((v) => !storeNameIsOwnName(v.name, owner.user.firstName, owner.user.lastName));
    if (misfit) {
      throw new AppError(400, 'OWN_NAME_MISMATCH', `“${misfit.name}” is not just your surname with your first names or initials, so the law asks you to register it as a business name. Choose “registered business” instead.`);
    }
    if (await validRegistrationRecord(prisma, userId)) {
      throw new AppError(409, 'ALREADY_REGISTERED', 'A business or company registration is on file for this account, so it can’t trade under a person’s own name. Contact Swift support if that registration has ended.');
    }
  }
  // The ask and its audit row commit together.
  const created = await prisma.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const row = await tx.accountChangeRequest.create({
      data: { tenantId: owner.user.tenantId, vendorOwnerId: owner.id, kind: 'BUSINESS_TYPE', requestedById: userId, fromOption, toOption },
      select: { id: true },
    }).catch(onePending);
    await tx.auditLog.create({ data: { userId, action: 'ASK_BUSINESS_TYPE_CHANGE', entity: 'AccountChangeRequest', entityId: row.id, changes: { fromOption, toOption } } });
    return row;
  });
  return viewOfChange(prisma, await loadChange(prisma, created.id));
}

/**
 * (d) The account holder names the new account holder: a company's (or a manager's) account only. The person named
 * must already have their own Swift account (they sign in on their own phone and file their own papers), hold no store
 * account of their own, and be on the same operator. One answer for every number that cannot be named, so this never
 * says which numbers are Swift accounts or why.
 */
export async function startHandover(prisma: PrismaClient, userId: string, phone: string): Promise<{ change: ChangeView; noticeId: string }> {
  const owner = await prisma.vendorOwner.findUnique({
    where: { userId },
    select: { id: true, accountBasis: true, user: { select: { tenantId: true, status: true } }, vendors: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (!owner || owner.vendors.length === 0) throw new AppError(403, 'STAFF_FORBIDDEN', 'Only the account holder can hand over the account');
  if (owner.accountBasis !== 'COMPANY' && owner.accountBasis !== 'MANAGER') {
    throw new AppError(409, 'HANDOVER_NOT_APPLICABLE', 'A business owner’s account isn’t handed over. If the business has a new owner, they sign up with their own papers.');
  }
  if (owner.user.status !== 'ACTIVE') throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
  const since = new Date(Date.now() - 86_400_000);
  const started = await prisma.accountChangeRequest.count({ where: { vendorOwnerId: owner.id, kind: 'HOLDER_HANDOVER', createdAt: { gt: since } } });
  // [review-2475 F8] A number that can't be named leaves a row (never the number), so the tries are counted too.
  const unnamed = await prisma.auditLog.count({ where: { action: 'HANDOVER_NAME_REFUSED', entity: 'VendorOwner', entityId: owner.id, createdAt: { gt: since } } });
  if (started >= HANDOVER_STARTS_PER_DAY || started + unnamed >= HANDOVER_TRIES_PER_DAY) {
    throw new AppError(429, 'HANDOVER_DAILY_LIMIT', 'You have named new account holders too many times today. Try again tomorrow.');
  }
  const target = await prisma.user.findUnique({ where: { phone }, select: { id: true, status: true, tenantId: true, vendorOwner: { select: { id: true } } } });
  if (!target || target.id === userId || target.status !== 'ACTIVE' || target.tenantId !== owner.user.tenantId || target.vendorOwner) {
    await prisma.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      await tx.auditLog.create({ data: { userId, action: 'HANDOVER_NAME_REFUSED', entity: 'VendorOwner', entityId: owner.id } });
    });
    throw new AppError(409, 'HANDOVER_PERSON_UNAVAILABLE', 'That number can’t be named. Ask the person to sign in to Swift on their own phone first. Someone who already holds a store account can’t be named.');
  }
  const { refuseReviewAccountRoleGrant } = await import('../review/demo-policy');
  await refuseReviewAccountRoleGrant(prisma, userId, target.id);
  const { change, noticeId } = await prisma.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const row = await tx.accountChangeRequest.create({
      data: { tenantId: owner.user.tenantId, vendorOwnerId: owner.id, kind: 'HOLDER_HANDOVER', requestedById: userId, holderId: userId, newHolderId: target.id },
      select: { id: true },
    }).catch(onePending);
    await tx.auditLog.create({ data: { userId, action: 'ASK_ACCOUNT_HANDOVER', entity: 'AccountChangeRequest', entityId: row.id, changes: { stores: owner.vendors.length } } });
    const stores = storeNames(owner.vendors);
    const notice = await insertNoticeFor(tx, {
      userId: target.id, type: 'SYSTEM_ANNOUNCEMENT', title: 'You were named as an account holder',
      body: `${stores} on Swift named you as the new account holder. Open Swift to say yes or no. Nothing changes until a person at Swift checks your papers.`,
      data: { kind: 'account_handover_named', changeId: row.id },
    });
    return { change: row, noticeId: notice.id };
  });
  return { change: await viewOfChange(prisma, await loadChange(prisma, change.id)), noticeId };
}

function storeNames(vendors: readonly { name: string }[]): string {
  const first = vendors[0]?.name.trim() || 'A store';
  return vendors.length > 1 ? `${first} (and ${vendors.length - 1} more branch${vendors.length === 2 ? '' : 'es'})` : first;
}

/** (d) The person named sees the handover waiting for them (never another person's papers). */
export async function handoversNaming(db: Db, userId: string): Promise<Array<ChangeView & { storeNames: string[]; basis: VendorAccountBasis }>> {
  const rows = await db.accountChangeRequest.findMany({ where: { newHolderId: userId, kind: 'HOLDER_HANDOVER', status: 'PENDING' }, select: CHANGE_SELECT, orderBy: { createdAt: 'desc' } });
  const out: Array<ChangeView & { storeNames: string[]; basis: VendorAccountBasis }> = [];
  for (const row of rows) out.push({ ...(await viewOfChange(db, row, { paperDetails: true })), storeNames: row.vendorOwner.vendors.map((v) => v.name), basis: row.vendorOwner.accountBasis });
  return out;
}

/** (d) The person named says yes (they then file their own papers) — once. */
export async function acceptHandover(prisma: PrismaClient, userId: string, changeId: string): Promise<ChangeView> {
  // The yes and its audit row commit together; a second yes changes nothing.
  const won = await prisma.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    const row = await tx.accountChangeRequest.updateMany({
      where: { id: changeId, newHolderId: userId, kind: 'HOLDER_HANDOVER', status: 'PENDING', newHolderAcceptedAt: null },
      data: { newHolderAcceptedAt: new Date() },
    });
    if (row.count === 1) await tx.auditLog.create({ data: { userId, action: 'ACCEPT_ACCOUNT_HANDOVER', entity: 'AccountChangeRequest', entityId: changeId } });
    return row.count === 1;
  });
  const change = await prisma.accountChangeRequest.findFirst({ where: { id: changeId, newHolderId: userId }, select: CHANGE_SELECT });
  if (!change) throw new NotFoundError('AccountChange', changeId);
  if (!won && change.status !== 'PENDING') throw new AppError(409, 'ACCOUNT_CHANGE_DECIDED', 'This handover has already been decided.');
  return viewOfChange(prisma, change, { paperDetails: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// Ending without a switch: a refusal, a withdrawal, a "no"
// ---------------------------------------------------------------------------------------------------------------------

/** The papers filed for a change that will never be approved leave review (waiting) or are withdrawn (approved), in the
 *  same transaction, so nothing of it can count later and the next change may file the same types again. */
async function closeChangePapers(tx: Prisma.TransactionClient, changeId: string, note: string, by: string): Promise<void> {
  await retirePapers(tx, { accountChangeId: changeId }, note, by);
}

/** Papers leave service in the decision's transaction: approved ones are withdrawn (REVOKED, their records with them),
 *  waiting ones leave review (EXPIRED). Returns how many. */
async function retirePapers(tx: Prisma.TransactionClient, where: Prisma.VerificationDocumentWhereInput, note: string, by: string): Promise<number> {
  const papers = await tx.verificationDocument.findMany({ where, select: { id: true, userId: true, state: true } });
  const now = new Date();
  let retired = 0;
  for (const paper of papers) {
    if (paper.state === 'COMMITTED') {
      await hopDocState(tx, { id: paper.id, userId: paper.userId }, 'COMMITTED', 'REVOKED', { status: 'REJECTED', reviewedBy: by, reviewedAt: now, reviewNote: `REVOKED: ${note}` });
      retired += 1;
    } else if (paper.state === 'REVIEW_QUEUED' || paper.state === 'IN_REVIEW' || paper.state === 'INFO_REQUESTED') {
      await hopDocState(tx, { id: paper.id, userId: paper.userId }, paper.state, 'EXPIRED', { reviewNote: note });
      await tx.reviewCase.updateMany({ where: { submissionId: paper.id, closedAt: null }, data: { closedAt: now } });
      retired += 1;
    }
  }
  return retired;
}

/**
 * [review-2475 F2] A saved card belongs to the person who enrolled it, for their own weekly fee: the old holder's cards on
 * the account's stores leave service in the handover's transaction (the removeInstrument path: REVOKED, its unsent
 * charges closed, a charge already handed off finishes and is reconciled), so the new holder is never charged on, or
 * shown, another person's card. Locked in the order a charge takes: payer -> subscription -> card.
 */
async function retireHolderCards(tx: Prisma.TransactionClient, storeIds: readonly string[], holderId: string, by: string, changeId: string): Promise<number> {
  const subs = await tx.subscription.findMany({ where: { vendorId: { in: [...storeIds] } }, select: { id: true } });
  if (subs.length === 0) return 0;
  // [delta D2] An "add a card" the old holder started and has not finished ends here: it can never save their card on
  // the account (the card rail also refuses a card whose owner is not the payer). A Pay now session is left to settle:
  // it may already have moved money, and it pays the store's fee.
  await tx.cardSession.updateMany({
    where: { subscriptionId: { in: subs.map((s) => s.id) }, userId: holderId, purpose: 'ENROLL', status: { in: ['OPEN', 'UNKNOWN'] } },
    data: { status: 'CANCELLED', failureCode: 'ACCOUNT_HANDED_OVER', confirmedAt: new Date() },
  });
  const cards = await tx.paymentInstrument.findMany({ where: { subscriptionId: { in: subs.map((s) => s.id) }, userId: holderId, status: 'ACTIVE' }, select: { id: true, subscriptionId: true } });
  if (cards.length === 0) return 0;
  const { closeUnsentCardIntents } = await import('../billing/billing.service');
  const { lockSubscriptionPayer } = await import('../subscription/mover-fee-authority');
  let revoked = 0;
  for (const card of cards) {
    await lockSubscriptionPayer(tx, card.subscriptionId);
    await tx.$queryRaw`SELECT "id" FROM "payment_instruments" WHERE "id" = ${card.id} FOR UPDATE /* account-handover-card */`;
    const now = new Date();
    const out = await tx.paymentInstrument.updateMany({ where: { id: card.id, userId: holderId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now, revokedBy: by } });
    if (out.count !== 1) continue;
    const unsent = await closeUnsentCardIntents(tx, { instrumentId: card.id }, 'CARD_OUT_OF_SERVICE', now);
    // [delta D4] The fee's own history, as a removal writes it (card-rail removeInstrument).
    const facts = await tx.paymentInstrument.findUniqueOrThrow({ where: { id: card.id }, select: { brand: true, last4: true, subscription: { select: { currencyCode: true } } } });
    await tx.billingEvent.create({ data: {
      subscriptionId: card.subscriptionId, type: 'TIER_CHANGE', currencyCode: facts.subscription.currencyCode, idempotencyKey: `card:revoked:${card.id}`,
      note: `Card ${facts.brand} ending ${facts.last4} removed: the account was handed over to a new account holder; no card is charged until the new holder adds one or chooses another way to pay`,
    } });
    await tx.auditLog.create({ data: {
      userId: by, action: 'CARD_REVOKED_ACCOUNT_HANDOVER', entity: 'PaymentInstrument', entityId: card.id,
      changes: { subscriptionId: card.subscriptionId, changeId, status: 'REVOKED', unsentChargesClosed: unsent },
    } });
    revoked += 1;
  }
  return revoked;
}

/**
 * Ends a PENDING change with nothing switched: a person's refusal (REFUSED, with the reason the store sees), the
 * holder withdrawing it, or the person named saying no (WITHDRAWN). Returns the notices to publish after commit.
 */
export async function endAccountChange(
  tx: Prisma.TransactionClient,
  input: { changeId: string; by: string; outcome: 'REFUSED' | 'WITHDRAWN'; reason?: string; audit: (tx: Prisma.TransactionClient, change: ChangeRow) => Promise<void> },
): Promise<string[]> {
  // Under the identity lock every document decision takes: no paper of this change is decided while it ends.
  await lockIdentityAuthority(tx);
  await tx.$queryRaw`SELECT "id" FROM "account_change_requests" WHERE "id" = ${input.changeId} FOR UPDATE /* account-change-decision */`;
  const change = await loadChange(tx, input.changeId);
  if (change.status !== 'PENDING') throw new AppError(409, 'ACCOUNT_CHANGE_DECIDED', 'This change has already been decided.');
  const now = new Date();
  await tx.accountChangeRequest.update({
    where: { id: change.id },
    data: { status: input.outcome, decidedAt: now, decidedById: input.by, decisionReason: input.reason ?? null },
  });
  const note = input.outcome === 'REFUSED' ? `the change was refused: ${input.reason}` : 'the change was withdrawn';
  await closeChangePapers(tx, change.id, note, input.by);
  // [FOLLOWUPS-2475] A letter of authority asked in Swift for the new business type, still waiting: never needed now.
  const letterFor = change.kind === 'BUSINESS_TYPE' ? changeLetterBasisOf(change.toOption, change.vendorOwner.accountBasis) : null;
  if (letterFor) {
    const [{ cancelChangeLetters }, { LETTER_DOC_TYPE }] = await Promise.all([import('./authority-letter/authority-letter.service'), import('./authority-letter/letter')]);
    await cancelChangeLetters(tx, { userId: change.vendorOwner.userId, docType: LETTER_DOC_TYPE[letterFor], by: input.by, changeId: change.id });
  }
  await input.audit(tx, change);
  const notices: string[] = [];
  const holder = change.vendorOwner.userId;
  const tell = async (userId: string, title: string, body: string, data: { kind: string; changeId: string }) => {
    if (userId === input.by) return; // the person who ended it knows
    notices.push((await insertNoticeFor(tx, { userId, type: 'SYSTEM_ANNOUNCEMENT', title, body, data })).id);
  };
  // (The kinds are written out, so the phone's notification census sees each one.)
  if (change.kind === 'BUSINESS_TYPE') {
    await tell(holder, 'Business type not changed', `Swift did not change your business type: ${input.reason ?? 'the request was withdrawn'}. Your store keeps selling as before.`,
      { kind: 'account_change_refused', changeId: change.id });
  } else {
    const why = input.outcome === 'REFUSED' ? `Swift did not approve the handover: ${input.reason}.` : 'The handover was withdrawn.';
    await tell(holder, 'Account not handed over', `${why} Nothing changed on your account.`, { kind: 'account_change_refused', changeId: change.id });
    if (change.newHolderId) {
      await tell(change.newHolderId, 'Account not handed over', `${why} You were not made the account holder.`, { kind: 'account_handover_ended', changeId: change.id });
    }
  }
  return notices;
}

/** The letter of authority a business type change asks for that the account's own basis does not: the new basis's
 *  (a company's director, or a registered business's owner for its manager), or null. */
function changeLetterBasisOf(toOption: BusinessTypeOption | null, current: VendorAccountBasis): 'COMPANY' | 'MANAGER' | null {
  const target = toOption ? shapeOf(toOption).basis : null;
  return (target === 'COMPANY' || target === 'MANAGER') && target !== current ? target : null;
}

/**
 * [FOLLOWUPS-2475 · Part 2 seam] The letter of authority the account holder's business type change still waiting asks
 * for, when it is not the account's own: the basis the letter is written for (vendor/authority-letter: who signs, which
 * letter). The signed letter is filed through VerificationService.submitDocument, which holds it for the change.
 */
export async function changeLetterBasis(db: Db, userId: string): Promise<{ basis: 'COMPANY' | 'MANAGER'; changeId: string } | null> {
  const change = await db.accountChangeRequest.findFirst({
    where: { status: 'PENDING', kind: 'BUSINESS_TYPE', vendorOwner: { userId } },
    select: { id: true, toOption: true, vendorOwner: { select: { accountBasis: true } } },
  });
  const basis = change ? changeLetterBasisOf(change.toOption, change.vendorOwner.accountBasis) : null;
  return basis && change ? { basis, changeId: change.id } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The seller's legal name (#2476: VendorOwner.sellerLegalName*, typed by the person who approves a registration paper)
// ---------------------------------------------------------------------------------------------------------------------

export interface TypedLegalName { name: string; at: Date; byId: string; documentId: string }
export type HeldLegalName = { changeId: string; from: string | null; fromDocumentId: string | null; to: string };

/**
 * [R3 · review-2476 F1] A legal name typed from a registration paper filed for a change, in that paper's decision
 * transaction. While the change waits it is HELD on the change (the account's own name, what customers see, does not
 * move: the store keeps selling on its old papers); `'HELD'` with the old -> new for the decision's trail. An approved
 * change's paper counts already: `'ACCOUNT'` (the caller names the account as for any paper). A refused or withdrawn
 * change's paper never names anyone: `'NONE'`.
 */
export async function holdChangeLegalName(
  tx: Prisma.TransactionClient, changeId: string, typed: TypedLegalName,
): Promise<{ to: 'HELD'; held: HeldLegalName } | { to: 'ACCOUNT' | 'NONE' }> {
  const [row] = await tx.$queryRaw<Array<{ status: string; sellerLegalName: string | null; sellerLegalNameDocId: string | null }>>`
    SELECT "status"::text AS status, "sellerLegalName", "sellerLegalNameDocId" FROM "account_change_requests"
    WHERE "id" = ${changeId} FOR UPDATE /* account-change-legal-name */`;
  if (row?.status === 'APPROVED') return { to: 'ACCOUNT' };
  if (row?.status !== 'PENDING') return { to: 'NONE' };
  await tx.accountChangeRequest.update({ where: { id: changeId }, data: {
    sellerLegalName: typed.name, sellerLegalNameAt: typed.at, sellerLegalNameById: typed.byId, sellerLegalNameDocId: typed.documentId,
  } });
  return { to: 'HELD', held: { changeId, from: row.sellerLegalName, fromDocumentId: row.sellerLegalNameDocId, to: typed.name } };
}

/** What an approval did to the account's legal name, for the caller's SET_SELLER_LEGAL_NAME row (#2476's trail). */
export interface SellerLegalNameMove {
  vendorOwnerId: string; accountId: string; documentId: string | null; docType: string | null;
  from: string | null; fromDocumentId: string | null; to: string | null;
}

/** What approving a change waiting would do to the account's seller legal name, read by the same rule the approval
 *  applies (`planSellerLegalName`): KEPT (nothing moves), SET to the name a person typed from the change's own
 *  registration paper (`docType`), or CLEARED. The console shows it before a person decides. */
export interface SellerLegalNameOnApproval {
  effect: 'KEPT' | 'SET' | 'CLEARED';
  /** The account's legal name now (what customers see while the change waits). */
  from: string | null;
  /** The account's legal name after approval. */
  to: string | null;
  /** SET: the change's paper the name was typed from. */
  docType: string | null;
  /** [review-2475 delta S4-2] A name was typed from the change's paper, but it is a person's (see isChangePersonsName), so
   *  approval does not use it: the console never promises customers will see it. */
  heldNameIsAPerson: boolean;
}

/** [review-2475 delta S4-2] What the approval's answer says of a legal name it did not use (never the name itself). */
export const SELLER_LEGAL_NAME_IS_A_PERSON_NOTICE = {
  code: 'LEGAL_NAME_IS_A_PERSON',
  message: 'The legal name typed from this change’s registration paper is a person’s name (an account holder’s, before or after the change, or someone named in a letter of authority), so approval did not make it the seller’s name. Customers see each store’s confirmed name, or “Ask the store”, until the registered business or company name is typed from a registration paper.',
} as const;
/** [review-2475 delta S4-1] A handover ended a store's seller-name confirmation that is a person's name. */
export const HANDOVER_SELLER_NAME_IS_A_PERSON_NOTICE = {
  // The same code as SELLER_NAME_IS_A_PERSON_NOTICE (verification.service), spelled here: the two modules import each other.
  code: 'SELLER_NAME_IS_A_PERSON',
  message: 'The seller name confirmed for this store is a person’s name (the new or the previous account holder’s, or someone named in a letter of authority), so the handover ended that confirmation. Customers see the account’s legal name if one is set, otherwise “Ask the store”, until a business name is confirmed.',
} as const;
/** [review-2480 B S4-2] A business type change left a store's name unconfirmed because it is a person's (the approval's
 *  answer; the same code as SELLER_NAME_IS_A_PERSON_NOTICE, in words that hold whatever else the approval set). */
export const CHANGE_SELLER_NAME_IS_A_PERSON_NOTICE = {
  code: 'SELLER_NAME_IS_A_PERSON',
  message: 'The store’s name is a person’s name (the account holder’s, or someone named in its letter of authority), so it was not confirmed as the seller’s name, and a confirmation given before ended. Customers see the account’s legal name if one is set, otherwise “Ask the store”.',
} as const;

/** The people a change is about, as the person-name rule reads them (never a name: user ids). */
type ChangePeopleRow = { kind: AccountChangeRequest['kind']; holderId: string | null; newHolderId: string | null; vendorOwner: { userId: string } };

/**
 * [review-2475 delta S4-1] Whose own names never name this change's seller: the account holder and, on a handover, the
 * holders before AND after it. `isAccountPersonsName` covers each one's own name and whoever their letters of authority
 * named, so a handover never makes the old holder (or their director) the seller of the business they handed on.
 */
function changePeople(change: ChangePeopleRow): string[] {
  const ids = change.kind === 'HOLDER_HANDOVER' ? [change.newHolderId, change.holderId, change.vendorOwner.userId] : [change.vendorOwner.userId];
  return [...new Set(ids.filter((id): id is string => !!id))];
}
export async function isChangePersonsName(db: Db, change: ChangePeopleRow, name: string): Promise<boolean> {
  for (const userId of changePeople(change)) if (await isAccountPersonsName(db, userId, name)) return true;
  return false;
}
/** The same, by the change's id (the paper-approval door, VerificationService.approveDocument). Unknown change: false. */
export async function isChangePersonsNameById(db: Db, changeId: string, name: string): Promise<boolean> {
  const change = await db.accountChangeRequest.findUnique({ where: { id: changeId }, select: { kind: true, holderId: true, newHolderId: true, vendorOwner: { select: { userId: true } } } });
  return change ? isChangePersonsName(db, change, name) : false;
}

/**
 * [COORD ruling 11 Nov 2026 · review-2479 · review-2475 delta S4-1/S4-2] Does approval leave this store's seller name
 * unconfirmed because the name is a person's? One rule for the approval and the console's flag. A business type change
 * confirms the store's own name, so that is the name checked; a handover confirms none, and a confirmation already on the
 * store is checked again against both holders (it ends when it is a person's).
 */
async function storeNameIsAPerson(db: Db, change: ChangePeopleRow, store: { name: string; sellerNameCheckedName: string | null }): Promise<boolean> {
  if (change.kind === 'BUSINESS_TYPE') return isChangePersonsName(db, change, store.name.trim());
  return store.sellerNameCheckedName !== null && isChangePersonsName(db, change, store.sellerNameCheckedName.trim());
}

const NO_LEGAL_NAME = { sellerLegalName: null, sellerLegalNameAt: null, sellerLegalNameById: null, sellerLegalNameDocId: null };

/**
 * [R3 · review-2476 · owner ruling 10 Nov 2026] The one rule for the account's legal name on approval, read by the
 * approval itself (settleSellerLegalName, in its transaction) and by the console's preview (adminChangeView): the legal
 * name a person typed from this change's own registration paper becomes the account's; with none held, the account's
 * legal name is CLEARED. It was typed for the old business type (or the old holder's papers), so it no longer names this
 * account's seller: a person's own name (allowed on an owner's business-name registration) never stays the seller of a
 * company's or a manager's account, a registered business's name never the seller of a company or of a trader under
 * their own name. The storefront then falls to the store names a person confirmed, or "Ask the store", until a person
 * types a name from a paper again.
 */
async function planSellerLegalName(db: Db, change: ChangeRow) {
  const held = await db.accountChangeRequest.findUniqueOrThrow({
    where: { id: change.id }, select: { sellerLegalName: true, sellerLegalNameAt: true, sellerLegalNameById: true, sellerLegalNameDocId: true },
  });
  const account = await db.vendorOwner.findUniqueOrThrow({ where: { id: change.vendorOwner.id }, select: { sellerLegalName: true, sellerLegalNameDocId: true } });
  // [review-2479] A person's own name is never stamped as the seller's: a held name that is one (the account's holder after
  // the change, or someone named in its letter of authority) is dropped, as if none was typed. [review-2475 delta S4-1] On
  // a handover the holder BEFORE it counts too (`change` is read before the account moves: isChangePersonsName).
  const typed = held.sellerLegalName && held.sellerLegalNameDocId ? held.sellerLegalName : null;
  const heldNameIsAPerson = typed !== null && await isChangePersonsName(db, change, typed);
  const next = typed !== null && !heldNameIsAPerson ? held : NO_LEGAL_NAME;
  const effect: SellerLegalNameOnApproval['effect'] =
    account.sellerLegalName === next.sellerLegalName && account.sellerLegalNameDocId === next.sellerLegalNameDocId ? 'KEPT'
      : next.sellerLegalName ? 'SET' : 'CLEARED';
  const paper = effect === 'SET' && next.sellerLegalNameDocId
    ? await db.verificationDocument.findUnique({ where: { id: next.sellerLegalNameDocId }, select: { docType: true } }) : null;
  return { effect, account, next, docType: paper?.docType ?? null, heldNameIsAPerson };
}

/** On approval, in the decision's transaction (the account's row is locked): planSellerLegalName, applied. `move`: null
 *  when nothing changed. `heldNameIsAPerson`: a typed name was not used (the approval's answer says why). */
async function settleSellerLegalName(tx: Prisma.TransactionClient, change: ChangeRow, holderAfter: string): Promise<{ move: SellerLegalNameMove | null; heldNameIsAPerson: boolean }> {
  const plan = await planSellerLegalName(tx, change);
  if (plan.effect === 'KEPT') return { move: null, heldNameIsAPerson: plan.heldNameIsAPerson };
  await tx.vendorOwner.update({ where: { id: change.vendorOwner.id }, data: plan.next });
  return { heldNameIsAPerson: plan.heldNameIsAPerson, move: {
    vendorOwnerId: change.vendorOwner.id, accountId: holderAfter, documentId: plan.next.sellerLegalNameDocId, docType: plan.docType,
    from: plan.account.sellerLegalName, fromDocumentId: plan.account.sellerLegalNameDocId, to: plan.next.sellerLegalName,
  } };
}

/** The console's preview of settleSellerLegalName for a change still waiting (a decided change: null). Read-only. */
export async function sellerLegalNameOnApproval(db: Db, change: ChangeRow): Promise<SellerLegalNameOnApproval | null> {
  if (change.status !== 'PENDING') return null;
  const plan = await planSellerLegalName(db, change);
  return { effect: plan.effect, from: plan.account.sellerLegalName, to: plan.next.sellerLegalName, docType: plan.docType, heldNameIsAPerson: plan.heldNameIsAPerson };
}

// ---------------------------------------------------------------------------------------------------------------------
// The switch: one transaction (VerificationService.decideAccountChange runs it, then the activation projection)
// ---------------------------------------------------------------------------------------------------------------------

export interface ApprovalInput {
  changeId: string;
  adminId: string;
  reason: string;
  /** (c) to a company, a registered business or a manager: each store's name exactly as the person saw it, which they
   *  confirm as the seller's business or company name (#2473: the storefront names the seller by it). */
  sellerNames?: Record<string, string>;
  audit: (tx: Prisma.TransactionClient, change: ChangeRow, facts: Record<string, unknown>) => Promise<void>;
  /** Is this store's checklist complete for this person (verification.service isRoleVerified, inside the transaction)? */
  storeComplete: (tx: Prisma.TransactionClient, holderUserId: string, store: StoreRow) => Promise<boolean>;
}

export interface ApprovalOutcome {
  /** Whose stores the activation projection reads after the switch. */
  holderUserId: string;
  notices: string[];
  /** (d) the old holder's sessions ended: the post-commit tail (sockets, mover outbox). */
  revoked?: { userId: string; cleanup: MoverSessionRevocationCleanup };
  /** The account's seller legal name moved (set from this change's paper, or cleared): the caller's trail row. */
  sellerLegalName?: SellerLegalNameMove;
  /** [review-2475 delta S4-2] For the approval's answer: the stores whose seller name approval left unconfirmed (or, on a
   *  handover, ended) because it is a person's, and a typed legal name approval did not use, each with why. */
  sellerNamesNotConfirmed?: { storeIds: string[]; code: string; message: string };
  sellerLegalNameNotUsed?: { code: string; message: string };
}

/** [delta D1] A store holder's business papers, whatever business type asked for them: every BUSINESS-bucket type, and
 *  the account holder's ID (asked only of a company's or a manager's holder). Never a personal ID other roles use. */
const STORE_BUSINESS_PAPERS: string[] = [...Object.entries(BUCKET_OF).filter(([, bucket]) => bucket === 'BUSINESS').map(([docType]) => docType), ACCOUNT_HOLDER_ID_DOC_TYPE];

/**
 * [review-2475 G1] The weekly fee's rail after a handover: the old holder's MMG payer number (the phone a push would ask)
 * is never kept, and a card rail left with no card (the old holder's revoked) is not either. Each such fee goes back to
 * what a new fee is born with (CASH: the fee is paid through the MMG checkout page), in the fee's history.
 */
async function resetHolderFeeRails(tx: Prisma.TransactionClient, storeIds: readonly string[], changeId: string): Promise<number> {
  const subs = await tx.subscription.findMany({ where: { vendorId: { in: [...storeIds] } }, select: { id: true, billingMethod: true, mmgPayerMsisdn: true, currencyCode: true } });
  let reset = 0;
  for (const sub of subs) {
    const cardLeft = sub.billingMethod === 'CARD' ? await tx.paymentInstrument.count({ where: { subscriptionId: sub.id, status: 'ACTIVE' } }) : 0;
    const was = sub.mmgPayerMsisdn !== null || sub.billingMethod === 'MOBILE_MONEY' ? 'MMG number' : sub.billingMethod === 'CARD' && cardLeft === 0 ? 'card' : null;
    if (!was) continue;
    await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${sub.id} FOR UPDATE /* account-handover-rail */`;
    await tx.subscription.update({ where: { id: sub.id }, data: { billingMethod: 'CASH', mmgPayerMsisdn: null } });
    await tx.billingEvent.create({ data: {
      subscriptionId: sub.id, type: 'TIER_CHANGE', currencyCode: sub.currencyCode, idempotencyKey: `rail:handover:${changeId}:${sub.id}`,
      note: `Billing rail set to CASH: the account was handed over to a new account holder, so the previous holder's ${was} no longer pays the weekly fee; it is paid through the MMG checkout page`,
    } });
    reset += 1;
  }
  return reset;
}

const paperWords = (missing: readonly string[]) => missing.map((t) => t.replace(/_/g, ' ')).join(', ');

export async function approveAccountChange(tx: Prisma.TransactionClient, input: ApprovalInput): Promise<ApprovalOutcome> {
  const first = await loadChange(tx, input.changeId);
  // The people first (the order every document decision locks in), then the change, the account and its stores.
  const people = [...new Set([first.vendorOwner.userId, ...(first.newHolderId ? [first.newHolderId] : [])])].sort();
  for (const id of people) await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id} FOR UPDATE /* account-change-decision */`;
  await tx.$queryRaw`SELECT "id" FROM "account_change_requests" WHERE "id" = ${input.changeId} FOR UPDATE /* account-change-decision */`;
  const change = await loadChange(tx, input.changeId);
  if (change.status !== 'PENDING') throw new AppError(409, 'ACCOUNT_CHANGE_DECIDED', 'This change has already been decided.');
  if (change.vendorOwner.userId !== first.vendorOwner.userId) throw new AppError(409, 'ACCOUNT_CHANGE_MOVED', 'The account changed while you were deciding. Open it again.');
  await tx.$queryRaw`SELECT "id" FROM "vendor_owners" WHERE "id" = ${change.vendorOwner.id} FOR UPDATE /* account-change-decision */`;
  const stores = change.vendorOwner.vendors;
  for (const store of stores) await tx.$queryRaw`SELECT "id" FROM "vendors" WHERE "id" = ${store.id} FOR UPDATE /* account-change-decision */`;
  const live = await tx.vendor.findMany({ where: { id: { in: stores.map((s) => s.id) } }, select: { id: true, name: true, suspensionSource: true, publicPhone: true, phone: true } });
  if (live.some((s) => s.suspensionSource === 'WIND_DOWN')) {
    throw new AppError(409, 'ACCOUNT_CLOSED', 'This account was closed. A closed account’s stores never reopen, so this change can’t be approved.');
  }

  // Every paper the change needs is approved (the change's own included), before anything moves.
  const { papers, perStore } = await readChangePapers(tx, change);
  const missing = papers.filter((p) => p.state !== 'APPROVED').map((p) => p.docType);
  if (missing.length > 0) {
    throw new AppError(409, 'CHANGE_PAPERS_INCOMPLETE', `Approve each paper first. Still waiting: ${paperWords(missing)}.`, { missing });
  }
  // Which stores pass their papers today: each must still pass them after the switch (no store goes dark by it).
  const holderBefore = change.vendorOwner.userId;
  const passedBefore = new Set<string>();
  for (const store of stores) if (await input.storeComplete(tx, holderBefore, store)) passedBefore.add(store.id);

  const now = new Date();
  await tx.accountChangeRequest.update({
    where: { id: change.id },
    data: { status: 'APPROVED', decidedAt: now, decidedById: input.adminId, decisionReason: input.reason },
  });
  const notices: string[] = [];
  let outcome: ApprovalOutcome;

  if (change.kind === 'BUSINESS_TYPE') {
    const target = shapeOf(change.toOption!);
    for (const store of stores) {
      if (!accountBasisApplies(target.basis, store.vendorType)) throw new AppError(409, 'ACCOUNT_BASIS_NOT_APPLICABLE', `${store.name} can’t be held that way.`);
    }
    // The seller name customers see [#2473]: a person confirms each store's exact name as the business's (a trader under
    // their own name is named by their own name instead, from the own-name declaration now counting).
    // [review-2475 F7] A change to "own name" is checked again at the decision, on the stores and papers as they are now:
    // every such store's name is the holder's own name, and no business or company registration is on file.
    if (target.ownName) {
      const holderNames = await tx.user.findUniqueOrThrow({ where: { id: holderBefore }, select: { firstName: true, lastName: true } });
      const misfit = live.find((s) => {
        const kind = stores.find((x) => x.id === s.id)?.vendorType;
        return kind !== undefined && ownNameKind(kind) && !storeNameIsOwnName(s.name, holderNames.firstName, holderNames.lastName);
      });
      if (misfit) throw new AppError(409, 'OWN_NAME_MISMATCH', `“${misfit.name.trim()}” is not the account holder’s own name now, so it can’t trade under their own name. Refuse the change.`);
      if (await validRegistrationRecord(tx, holderBefore)) {
        throw new AppError(409, 'ALREADY_REGISTERED', 'A business or company registration is on file for this account now, so it can’t trade under a person’s own name. Refuse the change.');
      }
    }
    if (!target.ownName) {
      for (const store of live) {
        const shown = input.sellerNames?.[store.id];
        if (shown === undefined) throw new AppError(400, 'SELLER_NAME_REQUIRED', `Confirm the name customers will see for ${store.name.trim()}.`);
        if (shown.trim() !== store.name.trim()) {
          throw new AppError(409, 'SELLER_NAME_CHANGED', `The store's name is now “${store.name.trim()}”. Check that name, then approve again.`);
        }
      }
    }
    await tx.vendorOwner.update({ where: { id: change.vendorOwner.id }, data: { accountBasis: target.basis } });
    // [review-2479 F6] Switching to or from the own name ends a seller-name confirmation given before (the person
    // approving confirms again below, where a store name may be confirmed at all).
    for (const store of stores) {
      const ownName = target.ownName && ownNameKind(store.vendorType);
      if (store.tradesUnderOwnName !== ownName) await tx.vendor.update({ where: { id: store.id }, data: { tradesUnderOwnName: ownName, ...SELLER_NAME_UNCONFIRMED } });
    }
    // The person approving confirms each store's exact name as the business's [#2473]. [COORD ruling 11 Nov 2026 ·
    // review-2479] Never a person's own name (the holder's, or someone named in the account's letter of authority): such
    // a store is not stamped (a name never blocks the approval), and the storefront names nobody until the legal name is
    // typed from a registration paper. A trader under their own name is named by their declaration, never a stamp.
    const confirmed: string[] = [];
    const notConfirmed: string[] = [];
    if (!target.ownName) {
      for (const store of live) {
        if (await storeNameIsAPerson(tx, change, { name: store.name, sellerNameCheckedName: null })) {
          // [review-2480 B S3-1] A confirmation written before #2479 (a person's name) ends too: never left naming the person.
          await tx.vendor.update({ where: { id: store.id }, data: SELLER_NAME_UNCONFIRMED });
          notConfirmed.push(store.id);
          continue;
        }
        await tx.vendor.update({ where: { id: store.id }, data: { sellerNameCheckedName: store.name.trim(), sellerNameCheckedAt: now, sellerNameCheckedById: input.adminId } });
        confirmed.push(store.id);
      }
    }
    await input.audit(tx, change, {
      fromOption: change.fromOption, toOption: change.toOption, stores: stores.length, sellerNamesConfirmed: confirmed,
      ...(notConfirmed.length ? { sellerNamesNotConfirmed: notConfirmed, sellerNameNotConfirmedCode: SELLER_NAME_IS_A_PERSON_NOTICE.code } : {}),
    });
    notices.push((await insertNoticeFor(tx, {
      userId: holderBefore, type: 'SYSTEM_ANNOUNCEMENT', title: 'Business type changed',
      body: 'Swift checked your new papers and changed your business type. Your store kept selling the whole time; nothing else changes.',
      data: { kind: 'account_change_approved', changeId: change.id },
    })).id);
    outcome = { holderUserId: holderBefore, notices };
    if (notConfirmed.length) outcome.sellerNamesNotConfirmed = { storeIds: [...notConfirmed].sort(), ...CHANGE_SELLER_NAME_IS_A_PERSON_NOTICE };
  } else {
    const newHolder = change.newHolderId!;
    if (!change.newHolderAcceptedAt) throw new AppError(409, 'HANDOVER_NOT_ACCEPTED', 'The person named has not said yes yet.');
    const person = await tx.user.findUniqueOrThrow({ where: { id: newHolder }, select: { status: true, tenantId: true, phone: true, roles: true, vendorOwner: { select: { id: true } } } });
    if (person.status !== 'ACTIVE' || person.phone === `deleted:${newHolder}`) throw new AppError(409, 'HANDOVER_PERSON_UNAVAILABLE', 'The person named no longer has an active Swift account.');
    if (person.vendorOwner) throw new AppError(409, 'HANDOVER_PERSON_HOLDS_ACCOUNT', 'The person named now holds a store account of their own, so this account can’t move to them.');
    const old = await tx.user.findUniqueOrThrow({ where: { id: holderBefore }, select: { phone: true, roles: true, activeRole: true } });
    // The account moves: every branch, in this one row.
    await tx.vendorOwner.update({ where: { id: change.vendorOwner.id }, data: { userId: newHolder } });
    const storeIds = stores.map((s) => s.id);
    // The new holder is the owner now: a staff or manager place they held at these stores ends.
    const staffEnded = await tx.vendorStaff.deleteMany({ where: { vendorId: { in: storeIds }, userId: { in: [newHolder, holderBefore] } } });
    // Their store role: the new holder gains it; the old holder keeps it only while a team place elsewhere needs it.
    await tx.user.update({ where: { id: newHolder }, data: { roles: { set: [...new Set([...person.roles, 'VENDOR_OWNER' as const])] } } });
    const teamElsewhere = await tx.vendorStaff.count({ where: { userId: holderBefore } });
    if (!teamElsewhere) {
      const roles = old.roles.filter((r) => r !== 'VENDOR_OWNER');
      await tx.user.update({
        where: { id: holderBefore },
        data: { roles: { set: roles.length ? roles : ['CUSTOMER'] }, ...(old.activeRole === 'VENDOR_OWNER' ? { activeRole: 'CUSTOMER' } : {}) },
      });
    }
    // Money never follows the old holder. The stores' MMG numbers customers pay (and any change of one still waiting) are
    // cleared; the new holder sets the company's own, through its usual hold, and customers can pay cash meanwhile. An
    // open order keeps the number it was placed with (Order.mmgNumberSnapshot). The weekly fee's own rail is reset
    // below (resetHolderFeeRails): the old holder's MMG payer number, and a card rail left with no card, are not kept.
    await tx.vendor.updateMany({ where: { id: { in: storeIds } }, data: { ...VENDOR_MMG_DESTINATION_CLEARED } });
    await closeOpenMmgStagesFor(tx, storeIds);
    // [review-2475 F2] Nor does a card: the old holder's saved cards on these stores leave service.
    const cardsRevoked = await retireHolderCards(tx, storeIds, holderBefore, input.adminId, change.id);
    // [review-2475 G1] Nor the fee's MMG payer number: each fee rail that was the old holder's goes back to a new fee's.
    const railsReset = await resetHolderFeeRails(tx, storeIds, change.id);
    // [review-2475 G2] Nor a letter of authority the old holder asked a director to sign: its link ends now.
    const { cancelLettersForHandover } = await import('./authority-letter/authority-letter.service');
    const lettersCancelled = await cancelLettersForHandover(tx, { holderId: holderBefore, vendorIds: storeIds, by: input.adminId, changeId: change.id });
    // [review-2475 F1 · delta D1] The account's papers name this business: they never follow the old holder to another
    // account (a company that names them next, or a store they open). Every paper of the account's lists they hold leaves
    // service, AND every business paper they filed as a store's holder under any earlier business type (a registration
    // from before the account became a company, an own-name declaration, a manager's letter). Their personal IDs
    // (owner_national_id, national_id) stay: a person's own ID is theirs, and other roles use it.
    const accountPapers = unionOf(perStore.values());
    const papersRetired = await retirePapers(tx, { userId: holderBefore, OR: [
      { role: 'VENDOR_OWNER', docType: { in: accountPapers } },
      { role: 'VENDOR_OWNER', docType: { in: STORE_BUSINESS_PAPERS } },
    ] },
      'the account was handed over to its new account holder; these papers belong to that business', input.adminId);
    // A store phone that is the old holder's own number stops being the store's: the published one is withdrawn, Swift's
    // private contact line becomes the new holder's number.
    for (const store of live) {
      if (store.publicPhone && store.publicPhone === old.phone) await tx.vendor.update({ where: { id: store.id }, data: { publicPhone: null } });
      if (store.phone === old.phone) await tx.vendor.update({ where: { id: store.id }, data: { phone: person.phone } });
    }
    // [review-2475 delta S4-1] A seller-name confirmation already on a store is checked again: one that is a person's name
    // (the new holder's, the old holder's, or someone their letters named) ends now. The business's own name stays.
    const unstamped: string[] = [];
    const stamped = await tx.vendor.findMany({ where: { id: { in: storeIds }, sellerNameCheckedName: { not: null } }, select: { id: true, name: true, sellerNameCheckedName: true } });
    for (const store of stamped) {
      if (!(await storeNameIsAPerson(tx, change, store))) continue;
      await tx.vendor.update({ where: { id: store.id }, data: SELLER_NAME_UNCONFIRMED });
      unstamped.push(store.id);
    }
    unstamped.sort();
    // The old holder loses access now: every session and device, in this transaction.
    const cleanup = await revokeAllSessionsInTransaction(tx, holderBefore, `account-handover:${change.id}`);
    await input.audit(tx, change, {
      stores: stores.length, staffPlacesEnded: staffEnded.count, mmgCleared: storeIds.length, cardsRevoked, feeRailsReset: railsReset, letterRequestsCancelled: lettersCancelled, oldHolderPapersRetired: papersRetired, oldHolderSessionsEnded: true,
      ...(unstamped.length ? { sellerNamesNotConfirmed: unstamped, sellerNameNotConfirmedCode: HANDOVER_SELLER_NAME_IS_A_PERSON_NOTICE.code } : {}),
    });
    const names = storeNames(stores);
    notices.push((await insertNoticeFor(tx, {
      userId: newHolder, type: 'SYSTEM_ANNOUNCEMENT', title: 'You now hold the account',
      body: `Swift checked your papers. You now hold the Swift account for ${names}. Add the business’s MMG number in Account so customers can pay by MMG again.${cardsRevoked > 0 ? ' The previous account holder’s card no longer pays the weekly fee: add your own card, or pay through the MMG checkout page.' : railsReset > 0 ? ' The previous account holder’s MMG number no longer pays the weekly fee: pay it through the MMG checkout page.' : ''}`,
      data: { kind: 'account_handover_completed', changeId: change.id },
    })).id);
    notices.push((await insertNoticeFor(tx, {
      userId: holderBefore, type: 'SYSTEM_ANNOUNCEMENT', title: 'Account handed over',
      body: `The Swift account for ${names} now belongs to the new account holder the business named. You no longer have access to it.`,
      data: { kind: 'account_handover_ended', changeId: change.id },
    })).id);
    outcome = { holderUserId: newHolder, notices, revoked: { userId: holderBefore, cleanup } };
    if (unstamped.length) outcome.sellerNamesNotConfirmed = { storeIds: unstamped, ...HANDOVER_SELLER_NAME_IS_A_PERSON_NOTICE };
  }

  // The seller's legal name follows the change, never the old business type or holder (settleSellerLegalName).
  const legalName = await settleSellerLegalName(tx, change, outcome.holderUserId);
  if (legalName.move) outcome.sellerLegalName = legalName.move;
  if (legalName.heldNameIsAPerson) outcome.sellerLegalNameNotUsed = { ...SELLER_LEGAL_NAME_IS_A_PERSON_NOTICE };

  // No store goes dark by the switch: a store that passed its papers before passes them after, or nothing moves.
  for (const store of stores) {
    if (!passedBefore.has(store.id)) continue;
    const reloaded = (await tx.vendor.findUniqueOrThrow({ where: { id: store.id }, select: { tradesUnderOwnName: true } }));
    if (!(await input.storeComplete(tx, outcome.holderUserId, { ...store, tradesUnderOwnName: reloaded.tradesUnderOwnName }))) {
      const list = perStore.get(store.id) ?? [];
      throw new AppError(409, 'CHANGE_PAPERS_INCOMPLETE', `${store.name} would lose its papers with this change (${paperWords(list)}). Nothing was changed.`);
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------------------------------
// The console's view (a person at Swift decides)
// ---------------------------------------------------------------------------------------------------------------------

export interface AdminChangeView extends ChangeView {
  vendorOwnerId: string;
  accountBasis: VendorAccountBasis;
  /** Every store of the account: the name a person confirms as the seller's (#2473), as it is now. [review-2475 delta
   *  S4-2] `nameIsAPerson`: approval leaves this store's seller name unconfirmed (a business type change) or ends its
   *  confirmation (a handover) because it is a person's (storeNameIsAPerson, the approval's own rule); false once decided. */
  stores: Array<{ id: string; name: string; vendorType: string; status: string; sellerNameCheckedName: string | null; nameIsAPerson: boolean }>;
  /** Names only (never a phone or a document): the reviewer matches them against the papers. */
  holder: { id: string; name: string };
  newHolder: { id: string; name: string } | null;
  decisionReason: string | null;
  /** [review-2475 F1] Which business the papers name: the legal name customers see now (`account`), and the one a person
   *  typed from THIS change's registration paper (`change`; null: none typed, so approving clears `account`). */
  legalName: { account: string | null; change: string | null };
  /** A change waiting: what approving it does to the account's seller legal name (settleSellerLegalName's own rule). */
  sellerLegalNameOnApproval: SellerLegalNameOnApproval | null;
}

const personName = (u: { firstName: string | null; lastName: string | null } | null): string =>
  [u?.firstName, u?.lastName].filter((x) => x && x.trim()).join(' ') || 'Unnamed';

export async function adminChangeView(db: Db, change: ChangeRow): Promise<AdminChangeView> {
  const view = await viewOfChange(db, change, { paperDetails: true });
  const [stores, holder, newHolder, names, onApproval] = await Promise.all([
    db.vendor.findMany({ where: { ownerId: change.vendorOwner.id }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, vendorType: true, status: true, sellerNameCheckedName: true } }),
    db.user.findUnique({ where: { id: change.holderId ?? change.requestedById }, select: { id: true, firstName: true, lastName: true } }),
    change.newHolderId ? db.user.findUnique({ where: { id: change.newHolderId }, select: { id: true, firstName: true, lastName: true } }) : null,
    db.accountChangeRequest.findUniqueOrThrow({ where: { id: change.id }, select: { sellerLegalName: true, vendorOwner: { select: { sellerLegalName: true } } } }),
    sellerLegalNameOnApproval(db, change),
  ]);
  return {
    legalName: { account: names.vendorOwner.sellerLegalName, change: names.sellerLegalName },
    ...view, vendorOwnerId: change.vendorOwner.id, accountBasis: change.vendorOwner.accountBasis,
    stores: await Promise.all(stores.map(async (s) => ({
      ...s, vendorType: String(s.vendorType), status: String(s.status),
      nameIsAPerson: change.status === 'PENDING' && await storeNameIsAPerson(db, change, s),
    }))),
    holder: { id: holder?.id ?? change.requestedById, name: personName(holder) },
    newHolder: newHolder ? { id: newHolder.id, name: personName(newHolder) } : null,
    decisionReason: change.decisionReason,
    sellerLegalNameOnApproval: onApproval,
  };
}

export async function adminChangeQueue(db: Db, status: AccountChangeRequest['status']): Promise<AdminChangeView[]> {
  const rows = await db.accountChangeRequest.findMany({ where: { status }, select: CHANGE_SELECT, orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' }, take: 100 });
  const out: AdminChangeView[] = [];
  for (const row of rows) out.push(await adminChangeView(db, row));
  return out;
}
