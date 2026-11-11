/**
 * [review-2479 final review S4-2] READ-ONLY deploy-day sweep: which seller names already on record would the new rule
 * refuse? Since #2479 a person's own name (the account holder's, a name the own-name rule accepts for them such as a
 * bare surname, or anyone named in a letter of authority) is never confirmed as a business's seller name, and a store
 * trading under its owner's own name is never stamped. Names confirmed or typed before this check are not re-checked
 * when shown, so this lists them for a person to review.
 *
 *   DATABASE_URL=... npx tsx scripts/seller-name-sweep.ts
 *
 * It writes NOTHING: it reads, runs the same matcher the doors use (isAccountPersonsName), and prints row ids and the
 * reason only. Names are personal data: they are never printed; look a row up in the console by its id.
 */
import { PrismaClient } from '@prisma/client';
import { isAccountPersonsName } from '../src/modules/verification/verification.service';

const prisma = new PrismaClient();

async function main() {
  const flagged: string[] = [];
  const stores = await prisma.vendor.findMany({
    where: { sellerNameCheckedName: { not: null } },
    select: { id: true, sellerNameCheckedName: true, tradesUnderOwnName: true, owner: { select: { userId: true } } },
  });
  for (const store of stores) {
    const name = store.sellerNameCheckedName!;
    if (store.tradesUnderOwnName) flagged.push(`store ${store.id}: confirmed seller name on a store trading under its owner's own name`);
    else if (await isAccountPersonsName(prisma, store.owner.userId, name)) flagged.push(`store ${store.id}: confirmed seller name is a person's name`);
  }
  const accounts = await prisma.vendorOwner.findMany({
    where: { sellerLegalName: { not: null } },
    select: { id: true, userId: true, sellerLegalName: true },
  });
  for (const account of accounts) {
    if (await isAccountPersonsName(prisma, account.userId, account.sellerLegalName!)) flagged.push(`account ${account.id}: typed legal name is a person's name`);
  }
  console.log(`seller-name sweep (read-only): ${stores.length} confirmed store names, ${accounts.length} typed legal names checked; ${flagged.length} the rule would refuse`);
  for (const line of flagged) console.log(`  ${line}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
