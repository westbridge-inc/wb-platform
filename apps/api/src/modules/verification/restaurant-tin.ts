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
 * paper. A TIN certificate a person REJECTED or REVOKED ends the exemption too: the owner sent one and it did not stand.
 *
 * "Live" is the activation projection's own mark: verified and past its first approval (isVerified, and the status is
 * not PENDING_APPROVAL). Read live on every check: nothing here caches anything.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { GRA_RESTAURANT_LICENCE_DOC_TYPE, RESTAURANT_TIN_ROLE, TIN_CERTIFICATE_DOC_TYPE } from './doc-registry';
import { holdsValidDocument } from './category-gate';
import { REPLACED_NOTE } from './replace-pending';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RestaurantStoreFacts { vendorType: string; isVerified: boolean; status: string }

/** A restaurant the activation projection holds live now. */
export function liveRestaurant(store: RestaurantStoreFacts): boolean {
  return store.vendorType === RESTAURANT_TIN_ROLE && store.isVerified && store.status !== 'PENDING_APPROVAL';
}

/** Did a person turn down a TIN certificate of this owner's: REVOKED (found false), or REJECTED by a reviewer (a copy
 *  the owner replaced before review is not a refusal)? Then no store of theirs is excused it. */
export async function tinCertificateRefused(db: Db, ownerUserId: string): Promise<boolean> {
  const refused = await db.verificationDocument.findFirst({
    where: {
      userId: ownerUserId, docType: TIN_CERTIFICATE_DOC_TYPE,
      OR: [{ state: 'REVOKED' }, { status: 'REJECTED', OR: [{ reviewNote: null }, { NOT: { reviewNote: { startsWith: REPLACED_NOTE } } }] }],
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
 * [S2-1 · S3-1] What the GRA licence is to an owner whose every store is a restaurant, for the words of its reminder and
 * its expiry notice: null when the owner has another kind of store (a supermarket's prepared food still needs the
 * licence: the old words stand); 'TIN_NEEDED' while the owner holds no valid TIN certificate (a live restaurant stands on
 * this licence: when it lapses, the TIN certificate is required); otherwise 'OPTIONAL'.
 */
export async function restaurantLicenceStanding(db: Db, ownerUserId: string, now = new Date()): Promise<'OPTIONAL' | 'TIN_NEEDED' | null> {
  const owner = await db.vendorOwner.findUnique({ where: { userId: ownerUserId }, select: { vendors: { select: { vendorType: true } } } });
  const stores = owner?.vendors ?? [];
  if (stores.length === 0 || !stores.every((v) => v.vendorType === RESTAURANT_TIN_ROLE)) return null;
  return (await holdsValidDocument(db, ownerUserId, TIN_CERTIFICATE_DOC_TYPE, now)) ? 'OPTIONAL' : 'TIN_NEEDED';
}
