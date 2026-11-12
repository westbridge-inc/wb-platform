/**
 * [RESTAURANT-TIN · owner ruling 12 Nov 2026] A restaurant's TIN certificate takes the GRA Food Restaurant Licence's
 * REQUIRED place (doc-registry withRestaurantTinRule); the licence is optional.
 *
 * [Owner, 12 Nov 2026, #2494 review S2-1] A restaurant ALREADY LIVE stays live only WHILE its GRA licence is valid: it
 * went live on the licence, so while the licence holds it is asked to ADD the TIN certificate (its owner's optional
 * list), never held for it, and its prepared food stays listed. When the licence lapses, is revoked or is rejected, the
 * TIN certificate is required like for a new restaurant (the licence's expiry reminder and expiry notice say so). No
 * other notice is sent.
 * A restaurant that is not live (a new one, or one coming back after its papers lapsed) needs it like any required
 * paper. A TIN certificate a person found FALSE (revoked, or rejected as fraud-class) ends the exemption too; an ordinary
 * rejection does not (tinCertificateRefused).
 *
 * "Live" is the activation projection's own mark: verified and past its first approval (isVerified, and the status is
 * not PENDING_APPROVAL). Read live on every check: nothing here caches anything.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { GRA_RESTAURANT_LICENCE_DOC_TYPE, RESTAURANT_TIN_ROLE, TIN_CERTIFICATE_DOC_TYPE } from './doc-registry';
import { holdsValidDocument } from './category-gate';
import { liveSubmissionWhere } from './evidence';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RestaurantStoreFacts { vendorType: string; isVerified: boolean; status: string }

/** A restaurant the activation projection holds live now. */
export function liveRestaurant(store: RestaurantStoreFacts): boolean {
  return store.vendorType === RESTAURANT_TIN_ROLE && store.isVerified && store.status !== 'PENDING_APPROVAL';
}

/**
 * [#2494 delta S3-B · COORD ruling 12 Nov 2026] The rejection reason codes that say a TIN certificate is FALSE: the fraud
 * class (verification.service FRAUD_CLASS_CODES; a unit test keeps the two equal, the service is not imported here). A
 * reviewer's coded rejection is stored as "[CODE] reason" in its review note.
 */
export const TIN_FALSE_REASON_CODES: readonly string[] = ['SUSPECTED_TAMPERING', 'DUPLICATE', 'FACE_MISMATCH'];

/**
 * Did a person find a TIN certificate of this owner's FALSE? Then no store of theirs is excused it.
 *  - [COORD ruling 12 Nov 2026, #2494 delta S3-B] Only a REVOKED certificate, or a rejection a reviewer marked
 *    fraud-class (TIN_FALSE_REASON_CODES), ends the exemption. An ordinary rejection (blurry, wrong file) does not:
 *    the owner's ruling ends it on the GRA licence's lapse, and a restaurant that tries early is never punished for it.
 *  - [#2494 delta S3-A] A paper filed for an account change that was withdrawn or refused is retired with that change
 *    (account-change retirePapers: REVOKED); it was never a decision on the certificate, so it is no refusal. Only
 *    papers that stand outside a change, or with an APPROVED one, are read (evidence.ts liveSubmissionWhere, #2475).
 */
export async function tinCertificateRefused(db: Db, ownerUserId: string): Promise<boolean> {
  const refused = await db.verificationDocument.findFirst({
    where: {
      userId: ownerUserId, docType: TIN_CERTIFICATE_DOC_TYPE,
      AND: [
        liveSubmissionWhere(),
        { OR: [{ state: 'REVOKED' }, ...TIN_FALSE_REASON_CODES.map((code) => ({ status: 'REJECTED' as const, reviewNote: { startsWith: `[${code}]` } }))] },
      ],
    },
    select: { id: true },
  });
  return refused !== null;
}

/** The exemption, owner-wide: a valid (approved, unexpired, current) GRA licence, and no TIN certificate turned down. */
export async function tinExemptionStands(db: Db, ownerUserId: string, now = new Date()): Promise<boolean> {
  if (!(await holdsValidDocument(db, ownerUserId, GRA_RESTAURANT_LICENCE_DOC_TYPE, now))) return false;
  return !(await tinCertificateRefused(db, ownerUserId));
}

/**
 * Is the TIN certificate excused (asked as a document to add, never a gate) for this owner's restaurant checklist?
 * With a store: that store is a live restaurant. Without one (the owner's Documents view): every restaurant of the
 * owner is live, so a new branch still waiting to go live keeps it required on the owner's list too. Either way only
 * while the exemption stands (tinExemptionStands).
 */
export async function tinCertificateExcused(db: Db, ownerUserId: string, vendorId?: string): Promise<boolean> {
  const owner = await db.vendorOwner.findUnique({
    where: { userId: ownerUserId },
    select: { vendors: { where: { vendorType: 'RESTAURANT' }, select: { id: true, vendorType: true, isVerified: true, status: true } } },
  });
  const stores = owner?.vendors ?? [];
  const judged = vendorId !== undefined ? stores.filter((s) => s.id === vendorId) : stores;
  if (judged.length === 0 || !judged.every((s) => liveRestaurant(s))) return false;
  return tinExemptionStands(db, ownerUserId);
}

/**
 * [S2-1 · S3-1 · #2494 delta S3-C] What the GRA licence is to an owner whose every store is a restaurant, for the words of
 * its reminder and its expiry notice:
 *  - null: the owner has another kind of store (a supermarket's prepared food still needs the licence: the old words);
 *  - 'OPTIONAL': the owner holds a valid TIN certificate;
 *  - 'TIN_PENDING': a TIN certificate of theirs is waiting for a person;
 *  - 'TIN_NEEDED_LIVE': a restaurant of theirs is live on this licence right now (excused: liveRestaurant and the
 *    exemption stands), so it stays live on it only until it lapses;
 *  - 'TIN_NEEDED': none is live on it (a pending application, a branch waiting for approval, a store already stopped).
 * Papers waiting for an account change do not count either way (liveSubmissionWhere).
 */
export type RestaurantLicenceStanding = 'OPTIONAL' | 'TIN_PENDING' | 'TIN_NEEDED_LIVE' | 'TIN_NEEDED';
export async function restaurantLicenceStanding(db: Db, ownerUserId: string, now = new Date()): Promise<RestaurantLicenceStanding | null> {
  const owner = await db.vendorOwner.findUnique({ where: { userId: ownerUserId }, select: { vendors: { select: { vendorType: true, isVerified: true, status: true } } } });
  const stores = owner?.vendors ?? [];
  if (stores.length === 0 || !stores.every((v) => v.vendorType === RESTAURANT_TIN_ROLE)) return null;
  if (await holdsValidDocument(db, ownerUserId, TIN_CERTIFICATE_DOC_TYPE, now)) return 'OPTIONAL';
  const pending = await db.verificationDocument.findFirst({
    where: { userId: ownerUserId, docType: TIN_CERTIFICATE_DOC_TYPE, status: 'PENDING', AND: [liveSubmissionWhere()] },
    select: { id: true },
  });
  if (pending) return 'TIN_PENDING';
  if (stores.some((v) => liveRestaurant(v)) && await tinExemptionStands(db, ownerUserId, now)) return 'TIN_NEEDED_LIVE';
  return 'TIN_NEEDED';
}
