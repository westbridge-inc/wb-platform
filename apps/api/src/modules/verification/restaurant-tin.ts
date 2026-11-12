/**
 * [RESTAURANT-TIN · owner ruling 12 Nov 2026] A restaurant's TIN certificate takes the GRA Food Restaurant Licence's
 * REQUIRED place (doc-registry withRestaurantTinRule); the licence is optional.
 *
 * A restaurant LIVE TODAY is never taken down for it: it went live on the rules of its day (the GRA licence), so the
 * TIN certificate is asked of it as a document to ADD (its owner's optional list), never a gate, and its prepared food
 * stays listed. The same rule as the food handlers tick (FOOD-PERMIT, verification.service projectVendorActivation): a
 * restaurant that is not live (a new one, or one coming back after its papers lapsed) needs it like any required paper.
 * A store whose owner's TIN certificate a person REVOKED (it was found false) is excused nothing.
 *
 * "Live" is the activation projection's own mark: verified and past its first approval (isVerified, and the status is
 * not PENDING_APPROVAL). Read live on every check: nothing here caches anything.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { RESTAURANT_TIN_ROLE, TIN_CERTIFICATE_DOC_TYPE } from './doc-registry';

type Db = PrismaClient | Prisma.TransactionClient;

export interface RestaurantStoreFacts { vendorType: string; isVerified: boolean; status: string }

/** A restaurant the activation projection holds live now. */
export function liveRestaurant(store: RestaurantStoreFacts): boolean {
  return store.vendorType === RESTAURANT_TIN_ROLE && store.isVerified && store.status !== 'PENDING_APPROVAL';
}

/** Did a person revoke a TIN certificate of this owner's? Then no store of theirs is excused it. */
export async function tinCertificateRevoked(db: Db, ownerUserId: string): Promise<boolean> {
  const revoked = await db.verificationDocument.findFirst({ where: { userId: ownerUserId, docType: TIN_CERTIFICATE_DOC_TYPE, state: 'REVOKED' }, select: { id: true } });
  return revoked !== null;
}

/**
 * Is the TIN certificate excused (asked as a document to add, never a gate) for this owner's restaurant checklist?
 * With a store: that store is a live restaurant. Without one (the owner's Documents view): every restaurant of the
 * owner is live, so a new branch still waiting to go live keeps it required on the owner's list too.
 */
export async function tinCertificateExcused(db: Db, ownerUserId: string, vendorId?: string): Promise<boolean> {
  const owner = await db.vendorOwner.findUnique({
    where: { userId: ownerUserId },
    select: { vendors: { where: { vendorType: 'RESTAURANT' }, select: { id: true, vendorType: true, isVerified: true, status: true } } },
  });
  const stores = owner?.vendors ?? [];
  const judged = vendorId !== undefined ? stores.filter((s) => s.id === vendorId) : stores;
  if (judged.length === 0 || !judged.every((s) => liveRestaurant(s))) return false;
  return !(await tinCertificateRevoked(db, ownerUserId));
}
