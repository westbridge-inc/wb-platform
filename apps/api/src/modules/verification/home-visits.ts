/**
 * [VERIFY-DOCS · owner ruling 6 Oct 2026, ~21:25 GYT] HOME VISITS NEED A POLICE CLEARANCE.
 *
 * "Service businesses: a home-visit booking is possible only while the owner holds an
 * approved, current police clearance; in-shop listings never need it." Marketplace
 * tradespeople (SERVICE_PROVIDER) keep it as a requirement of their own list.
 *
 * A home visit is an appointment listing whose service mode brings the business to the
 * customer: MOBILE, or BOTH when the customer does not choose the business's place
 * (the checkout's own rule, order.service). The clearance is read through THE evidence
 * rule (document records): approved, VALID and unexpired — so it survives its image
 * being deleted after review, and lapses with the certificate's re-check date.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { guyanaDayKey, startOfGuyanaDay } from '../../utils/guyana-day';
import { approvedEvidenceFor } from './evidence';
import { POLICE_CLEARANCE_DOC_TYPE, SELFIE_COMPARE_DOC_TYPES } from './doc-registry';
import { isDocumentValidAt } from './document-validity';
import { ownerWallSystem } from '../../lib/owner-rls';

type Db = Prisma.TransactionClient | PrismaClient;

export const HOME_VISIT_UNAVAILABLE = 'HOME_VISIT_UNAVAILABLE';
export const HOME_VISITS_PAUSED_TITLE = 'Home visits are paused';

/** Does the owner hold an approved, current police clearance? */
export async function homeVisitsCleared(db: Db, ownerUserId: string, now: Date = new Date()): Promise<boolean> {
  return (await approvedEvidenceFor(db, ownerUserId, [POLICE_CLEARANCE_DOC_TYPE], now)).length > 0;
}

/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026] The profile photo (the signup selfie) is asked only where a stranger comes to the
 * customer: riders and drivers (go-online gates), and a service business's HOME VISITS. A store owner, store staff and a
 * business that serves customers only at its own place never need one. A home visit books only while the owner has the
 * photo, beside the police clearance; in-shop bookings are never affected.
 */
export async function ownerHasProfilePhoto(db: Db, ownerUserId: string): Promise<boolean> {
  const owner = await db.user.findUnique({ where: { id: ownerUserId }, select: { selfieCapturedAt: true } });
  return !!owner?.selfieCapturedAt;
}

/**
 * [OWNER-ASKS · security review 9 Nov 2026] THE SELFIE MUST HAVE BEEN COMPARED WITH THE APPROVED ID. An in-shop owner's ID
 * is approved with no selfie beside it; if that owner later turns on home visits and takes the photo, nothing ties the
 * new face to the ID — anyone could take it. So a home visit books only once a PERSON on the verification team has
 * compared THIS selfie (the capture `selfieCapturedAt` names) with the owner's approved, current photo ID and recorded a
 * match (POST /admin/verification/:id/selfie-check, the reviewer grant, a stated reason). The record is the append-only
 * audit row SELFIE_ID_COMPARED; a retaken selfie, a "no match", or an ID that is no longer approved and current
 * un-authorizes it (fail closed). Automatic face matching is off (FD-D5) and never stands in for this check.
 */
export const SELFIE_ID_COMPARED_ACTION = 'SELFIE_ID_COMPARED';

export interface SelfieIdComparison { documentId: string; selfieCapturedAt: string; avatar: string; outcome: 'MATCH' | 'NO_MATCH' }

export interface SelfieCheckRow { reviewerId: string | null; record: Partial<SelfieIdComparison> }

/** [review F3/F5] Every recorded answer about THIS selfie (capture time + stored object), oldest first, ties by id. */
export async function selfieChecksFor(db: Db, ownerUserId: string, selfie: { selfieCapturedAt: Date; avatar: string }): Promise<SelfieCheckRow[]> {
  const rows = await db.auditLog.findMany({
    where: { action: SELFIE_ID_COMPARED_ACTION, entity: 'User', entityId: ownerUserId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true, changes: true },
  });
  const at = selfie.selfieCapturedAt.toISOString();
  return rows
    .map((row) => ({ reviewerId: row.userId, record: (row.changes ?? {}) as Partial<SelfieIdComparison> }))
    .filter((row) => row.record.selfieCapturedAt === at && row.record.avatar === selfie.avatar);
}

/**
 * [review F3] A NO_MATCH is final for that selfie: only a MATCH recorded AFTER the last NO_MATCH, by a reviewer who
 * never said NO_MATCH about it, counts (the override is flagged to ops when it is recorded); otherwise the person
 * retakes the photo. Without a NO_MATCH, any MATCH counts. Deterministic: (createdAt, id) order, never "the latest".
 */
export function standingMatch(rows: readonly SelfieCheckRow[]): SelfieCheckRow | null {
  let lastNo = -1;
  const refusers = new Set<string | null>();
  rows.forEach((row, i) => { if (row.record.outcome === 'NO_MATCH') { lastNo = i; refusers.add(row.reviewerId); } });
  return rows.slice(lastNo + 1).find((row) => row.record.outcome === 'MATCH' && !refusers.has(row.reviewerId)) ?? null;
}

export async function ownerPhotoMatchedToId(db: Db, ownerUserId: string, now: Date = new Date()): Promise<boolean> {
  const owner = await db.user.findUnique({ where: { id: ownerUserId }, select: { selfieCapturedAt: true, avatar: true } });
  if (!owner?.selfieCapturedAt || !owner.avatar) return false;
  // [security review 9 Nov, 2nd] the compared photo is named by its capture time AND its stored object
  const match = standingMatch(await selfieChecksFor(db, ownerUserId, { selfieCapturedAt: owner.selfieCapturedAt, avatar: owner.avatar }));
  if (!match || typeof match.record.documentId !== 'string') return false;
  const id = await db.verificationDocument.findFirst({
    where: { id: match.record.documentId, userId: ownerUserId, status: 'APPROVED', state: 'COMMITTED', docType: { in: [...SELFIE_COMPARE_DOC_TYPES] } },
    select: { expiresAt: true },
  });
  return !!id && isDocumentValidAt(id.expiresAt, now);
}

/**
 * [review F1] THE FULL HOME-VISIT GATE, for a moment after checkout: a business accepting a requested home visit, or a
 * home visit being moved. Clearance + photo + a standing MATCH + a current ID, read through `db` (the caller's
 * transaction). [security review 9 Nov] An APPOINTMENT order is a home visit when checkout marked it so (`homeVisit`,
 * from the listing's mode and the customer's choice); the distance never decides it (a 0-km visit is still a visit).
 */
export function isHomeVisitOrder(order: { fulfillment: string | null; homeVisit: boolean }): boolean {
  return order.fulfillment === 'APPOINTMENT' && order.homeVisit === true;
}

export async function assertOwnerHomeVisitsOpen(db: Db, ownerUserId: string, audience: 'business' | 'customer', vendorName: string): Promise<void> {
  const [cleared, photo, matched] = [await homeVisitsCleared(db, ownerUserId), await ownerHasProfilePhoto(db, ownerUserId), await ownerPhotoMatchedToId(db, ownerUserId)];
  if (cleared && photo && matched) return;
  if (audience === 'customer') throw homeVisitRefusal(vendorName, false);
  throw new AppError(409, HOME_VISIT_UNAVAILABLE, `Home visits are paused for ${vendorName}: they need ${homeVisitNeeds(cleared, photo, matched)}. Bookings at your place are not affected.`);
}

function homeVisitNeeds(cleared: boolean, photo: boolean, matched: boolean): string {
  const needs = [
    ...(cleared ? [] : ['your police clearance, approved and current (upload it under Documents)']),
    ...(photo ? [] : ['your profile photo, so customers see who is coming (take it in the Swift app)']),
    ...(photo && !matched ? ['our team to check your profile photo against your approved ID (we do this; nothing to send)'] : []),
  ];
  return needs.length ? needs.join(', and ') : 'your police clearance, approved and current (upload it under Documents)';
}

/**
 * [review F1 · COORD ruling pending the owner's confirmation] When the check is lost (a "no match"), home visits the
 * business already CONFIRMED are not cancelled: they stay, and the owner is told that new home visits are paused and why.
 * One small function so the rule can change in one place.
 */
export async function tellOwnerHomeVisitCheckLost(
  notifications: { send: (input: { userId: string; type: 'SYSTEM_ANNOUNCEMENT'; title: string; body: string; audience: 'business' }) => Promise<unknown> },
  ownerUserId: string,
): Promise<void> {
  await notifications.send({
    userId: ownerUserId, type: 'SYSTEM_ANNOUNCEMENT', audience: 'business', title: HOME_VISITS_PAUSED_TITLE,
    body: 'Our team could not match your profile photo with your approved ID, so new home visits are paused. Take a new profile photo in the Swift app; we will check it again. Home visits you already confirmed are not cancelled, and bookings at your place are not affected.',
  });
}

/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026 ~20:1xZ (A)] AN INDEPENDENT SERVICE PRO (the services marketplace, signed up from
 * the customer app) goes to customers' homes: like a home-visit business, the pro takes new home work only with the
 * profile photo AND a person's recorded check of THAT photo against the approved ID (ownerPhotoMatchedToId). Read at
 * every "new work" door, beside the weekly-fee door (assertProFeeAllowsNewWork): a request, a booking, a quote, an
 * acceptance, a confirmation. A pro without it is paused from home jobs, fail closed, and told what to add.
 */
export const PRO_HOME_JOBS_PAUSED = 'PRO_HOME_JOBS_PAUSED';
export const PRO_HOME_JOBS_ADD_PHOTO = 'Home jobs are paused: add your profile photo in the Swift app (Profile, then Services). Customers see who is coming to their home.';
export const PRO_HOME_JOBS_PHOTO_CHECKING = 'Home jobs are paused while our team checks your profile photo against your approved ID. There is nothing to send; you will be told when it is done.';

export async function proHomeJobsReady(db: Db, providerUserId: string): Promise<{ photo: boolean; photoChecked: boolean }> {
  const photo = await ownerHasProfilePhoto(db, providerUserId);
  return { photo, photoChecked: photo && (await ownerPhotoMatchedToId(db, providerUserId)) };
}

export async function assertProHomeJobsAllowed(db: Db, providerUserId: string, who: 'customer' | 'provider'): Promise<void> {
  const ready = await proHomeJobsReady(db, providerUserId);
  if (ready.photo && ready.photoChecked) return;
  throw new AppError(409, PRO_HOME_JOBS_PAUSED, who === 'provider'
    ? (ready.photo ? PRO_HOME_JOBS_PHOTO_CHECKING : PRO_HOME_JOBS_ADD_PHOTO)
    : 'This provider can\u2019t take home jobs right now. Choose another provider, or try again later.');
}

/** Does any store this person owns list a service that comes to the customer? */
export async function ownerOffersHomeVisits(db: Db, ownerUserId: string): Promise<boolean> {
  const listing = await db.item.findFirst({
    where: {
      vendor: { owner: { userId: ownerUserId } },
      fulfillment: 'APPOINTMENT',
      archivedAt: null, // [review F2] an archived listing offers nothing
      OR: [
        { bookingConfig: { path: ['serviceMode'], equals: 'MOBILE' } },
        { bookingConfig: { path: ['serviceMode'], equals: 'BOTH' } },
      ],
    },
    select: { id: true },
  });
  return listing !== null;
}

/** What the customer is told. A BOTH listing can still be booked at the business's place. */
export function homeVisitRefusal(vendorName: string, inShopAvailable: boolean): AppError {
  return new AppError(
    409,
    HOME_VISIT_UNAVAILABLE,
    inShopAvailable
      ? `${vendorName} can't come to your home yet. You can book this service at their place instead.`
      : `${vendorName} can't come to your home yet, so this service can't be booked right now. Please try again later.`,
  );
}

/**
 * What the owner is told, at most once a Guyana day: a customer wanted a home visit and
 * could not book one, and what unlocks it. Never thrown into the customer's checkout.
 */
export async function tellOwnerHomeVisitsPaused(
  db: Db,
  notifications: { send: (input: { userId: string; type: 'SYSTEM_ANNOUNCEMENT'; title: string; body: string; audience: 'business'; dedupeKey?: string }) => Promise<unknown> },
  ownerUserId: string,
  vendorName: string,
  now: Date = new Date(),
): Promise<boolean> {
  // [item 20] The store owner's notice, looked up from a customer's checkout: the named capability under the owner wall.
  const already = await ownerWallSystem('home-visits:owner-told-today', () => db.notification.findFirst({
    where: { userId: ownerUserId, title: HOME_VISITS_PAUSED_TITLE, createdAt: { gte: startOfGuyanaDay(guyanaDayKey(now)) } },
    select: { id: true },
  }));
  if (already) return false;
  // [OWNER-ASKS 9 Nov] Name exactly what is missing: the police clearance, the profile photo, or both.
  const [cleared, photo, matched] = await Promise.all([homeVisitsCleared(db, ownerUserId, now), ownerHasProfilePhoto(db, ownerUserId), ownerPhotoMatchedToId(db, ownerUserId, now)]);
  const what = homeVisitNeeds(cleared, photo, matched);
  await notifications.send({
    userId: ownerUserId,
    type: 'SYSTEM_ANNOUNCEMENT',
    title: HOME_VISITS_PAUSED_TITLE,
    body: `A customer tried to book a home visit from ${vendorName}. Home visits need ${what}. Bookings at your place are not affected.`,
    audience: 'business',
    dedupeKey: `home-visits-paused:${guyanaDayKey(now)}`,
  });
  return true;
}
