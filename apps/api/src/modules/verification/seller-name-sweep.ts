/**
 * [review-2479 final review S4-2 · R5 review S3-A] The READ-ONLY deploy-day sweep behind scripts/seller-name-sweep.ts:
 * which seller names already on record would the rule refuse? Names confirmed or typed before #2479 are not re-checked
 * when shown, so this lists them, by row id and reason only (names are personal data), for a person to review.
 *
 * It reads across every tenant, so it runs only on a login that sees every tenant (the system login, a member of
 * swift_bypass_rls). On a walled login the tenant policy hides every row and the sweep would report a false
 * "nothing to fix": sweepLoginRefusal says so, and the script stops.
 */
import type { PrismaClient } from '@prisma/client';
import type { RlsFacts } from '../../lib/rls-attestation';
import { isAccountPersonsName } from './verification.service';

/** Why this login may not run the sweep, or null when it sees every tenant. Names roles only, never a connection string. */
export function sweepLoginRefusal(facts: RlsFacts): string | null {
  if (facts.roleResolved && facts.isBypassRoleMember) return null;
  return `The database login (${facts.role}) cannot see every tenant (it is not a member of swift_bypass_rls), so the sweep would find nothing. Run it on the system login: DATABASE_URL="$SYSTEM_DATABASE_URL".`;
}

export interface SellerNameSweep { storesSeen: number; storeNamesChecked: number; legalNamesChecked: number; flagged: string[] }

/** Reads only. Every listed row is named by its id and the reason, never by the name. */
export async function sellerNameSweep(db: Pick<PrismaClient, 'vendor' | 'vendorOwner' | 'user' | 'authorityLetterRequest'>): Promise<SellerNameSweep> {
  const flagged: string[] = [];
  const storesSeen = await db.vendor.count();
  const stores = await db.vendor.findMany({
    where: { sellerNameCheckedName: { not: null } },
    select: { id: true, sellerNameCheckedName: true, tradesUnderOwnName: true, owner: { select: { userId: true } } },
  });
  for (const store of stores) {
    if (store.tradesUnderOwnName) flagged.push(`store ${store.id}: confirmed seller name on a store trading under its owner's own name`);
    else if (await isAccountPersonsName(db, store.owner.userId, store.sellerNameCheckedName!)) flagged.push(`store ${store.id}: confirmed seller name is a person's name`);
  }
  const accounts = await db.vendorOwner.findMany({ where: { sellerLegalName: { not: null } }, select: { id: true, userId: true, sellerLegalName: true } });
  for (const account of accounts) {
    if (await isAccountPersonsName(db, account.userId, account.sellerLegalName!)) flagged.push(`account ${account.id}: typed legal name is a person's name`);
  }
  return { storesSeen, storeNamesChecked: stores.length, legalNamesChecked: accounts.length, flagged };
}
