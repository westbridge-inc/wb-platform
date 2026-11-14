/**
 * [COMPANY-DOCS · owner rulings 10 Nov 2026 ~07:0xZ, ~07:2xZ] Who holds a store account, and so which papers the WHOLE
 * account gives. One choice at sign-up, three answers:
 *  1. "We're a registered company" (incorporated, e.g. KFC) → COMPANY: the certificate of incorporation (or the company's
 *     business registration), the ID of the ONE person who manages the Swift account, and a letter of authority from a
 *     director (or the director listing). Never an owner's ID.
 *  2. "We're a registered business" (a business-name registration) → OWNER: the owner's ID and the business registration
 *     (today's path). Its sub-option "I'm the manager, not the owner" → MANAGER: the manager's ID, a letter of authority
 *     signed by the owner, and the business registration.
 *  3. "I trade under my own name" → OWNER, with the store's own-name declaration (vendor/own-name.ts, per store).
 * A person at Swift checks every paper. Branches ride the account's choice and upload nothing; staff upload nothing.
 * Every existing account is OWNER and keeps the papers it has (VendorOwner.accountBasis defaults to OWNER).
 */
import type { PrismaClient, Prisma, VendorAccountBasis } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { COMPANY_TIER, MANAGER_TIER } from '../verification/doc-registry';

export const ACCOUNT_BASES = ['OWNER', 'COMPANY', 'MANAGER'] as const satisfies readonly VendorAccountBasis[];
export type AccountBasis = (typeof ACCOUNT_BASES)[number];

/**
 * The store types each non-owner basis is open to: the types with a `<ROLE>_COMPANY` / `<ROLE>_MANAGER` list
 * (ops/platform-config). A service business may be a company; a service business has no registration naming its owner,
 * so its manager path is not offered (an owner's letter could not be checked against anything).
 */
export const ACCOUNT_BASIS_VENDOR_TYPES: Readonly<Record<Exclude<AccountBasis, 'OWNER'>, readonly string[]>> = {
  COMPANY: ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'],
  MANAGER: ['RESTAURANT', 'SUPERMARKET', 'STORE'],
};

/** Does this basis apply to this store type? OWNER applies to every type. */
export function accountBasisApplies(basis: AccountBasis, vendorType: string): boolean {
  return basis === 'OWNER' || ACCOUNT_BASIS_VENDOR_TYPES[basis].includes(vendorType);
}

/** The checklist tier an account's basis puts a store type on, or undefined (the owner's standard / own-name logic). */
export function accountTierOf(basis: AccountBasis | null | undefined, vendorType: string): string | undefined {
  if (!basis || basis === 'OWNER' || !accountBasisApplies(basis, vendorType)) return undefined;
  return basis === 'COMPANY' ? COMPANY_TIER : MANAGER_TIER;
}

type Db = Pick<PrismaClient, 'vendorOwner'> | Pick<Prisma.TransactionClient, 'vendorOwner'>;

/**
 * The basis a new store is created under, checked before it exists (sign-up and add-a-branch, business-input.ts):
 *  - an account that already has a store keeps its basis: a branch rides it (a different one sent is refused: the
 *    account's papers are one set);
 *  - a first store takes the basis sent (absent = OWNER, as every older client);
 *  - a company or manager account never trades under the owner's own name, and a basis is open only to its types.
 */
export async function assertAccountBasisAllowed(
  db: Db, userId: string, business: { vendorType: string; nameBasis?: string; accountBasis?: AccountBasis },
): Promise<AccountBasis> {
  const owner = await db.vendorOwner.findUnique({ where: { userId }, select: { accountBasis: true, _count: { select: { vendors: true } } } });
  const hasStore = (owner?._count?.vendors ?? 0) > 0;
  const held: AccountBasis = owner?.accountBasis ?? 'OWNER';
  if (hasStore && business.accountBasis !== undefined && business.accountBasis !== held) {
    throw new AppError(409, 'ACCOUNT_BASIS_FIXED', 'Your branches use the papers your account already gave Swift, so they sign up the same way as your first store.');
  }
  const basis: AccountBasis = hasStore ? held : (business.accountBasis ?? 'OWNER');
  if (basis !== 'OWNER' && business.nameBasis === 'OWN_NAME') {
    throw new AppError(400, 'ACCOUNT_BASIS_OWN_NAME', basis === 'COMPANY'
      ? 'A registered company trades under its company name, not under a person’s own name.'
      : 'Only the owner can trade under their own name. As the manager, sign up the owner’s registered business.');
  }
  if (!accountBasisApplies(basis, business.vendorType)) {
    throw new AppError(400, 'ACCOUNT_BASIS_NOT_APPLICABLE', basis === 'MANAGER'
      ? 'A manager can sign up a registered restaurant, supermarket or store. A service business signs up on its owner’s own account.'
      : 'This kind of business can’t sign up as a registered company yet.');
  }
  return basis;
}
