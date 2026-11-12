/**
 * [review-2479 final review S4-2 · R5 review S3-A] READ-ONLY deploy-day sweep: which seller names already on record
 * would the new rule refuse? Since #2479 a person's own name (the account holder's, a name the own-name rule accepts
 * for them such as a bare surname, or anyone named in a letter of authority) is never confirmed as a business's seller
 * name, and a store trading under its owner's own name is never stamped. Names confirmed or typed before this check
 * are not re-checked when shown, so this lists them for a person to review.
 *
 * Run it on the SYSTEM login, which sees every tenant (a member of swift_bypass_rls):
 *
 *   DATABASE_URL="$SYSTEM_DATABASE_URL" npx tsx scripts/seller-name-sweep.ts
 *
 * On any other login the tenant wall hides every row and the answer would be a false "nothing to fix": the script
 * refuses such a login and exits 2. It writes NOTHING: it reads, runs the same matcher the doors use, and prints the
 * number of stores it saw (0 there means it saw nothing), then row ids and reasons only. Names are personal data: they
 * are never printed; look a row up in the console by its id.
 */
import { PrismaClient } from '@prisma/client';
import { readRlsFacts } from '../src/lib/rls-attestation';
import { sellerNameSweep, sweepLoginRefusal } from '../src/modules/verification/seller-name-sweep';

const prisma = new PrismaClient();

async function main(): Promise<number> {
  const refusal = sweepLoginRefusal(await readRlsFacts(prisma));
  if (refusal) {
    console.error(`seller-name sweep refused: ${refusal}`);
    return 2;
  }
  const result = await sellerNameSweep(prisma);
  console.log(`seller-name sweep (read-only): ${result.storesSeen} stores seen; ${result.storeNamesChecked} confirmed store names and ${result.legalNamesChecked} typed legal names checked; ${result.flagged.length} the rule would refuse`);
  for (const line of result.flagged) console.log(`  ${line}`);
  return 0;
}

main()
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
