import { PrismaClient } from '@prisma/client';
import { backfillBillingConfirmation } from '../../modules/billing/billing-confirmation-backfill';
import { environmentForTests, lockTestTarget } from './target-lock';

/**
 * [#1393 · migration 20260930180000] A test database built by replaying the
 * migrations holds weekly-fee effects BLOCKED until the versioned confirmation
 * backfill proves full coverage. Production completes that backfill in its
 * cutover runbook (apps/api/BILLING-CONFIRMATION-CUTOVER.md) with every old
 * writer stopped. The disposable test database completes it here, once, through
 * the same code and the same owner-only SQL boundary, after the same target
 * gate every run passes (it runs again here, so this step can never reach a
 * database that gate would refuse). An already READY database is left exactly
 * as it is; a database whose owners are invalid fails the run loudly instead of
 * testing billing while it is blocked.
 */
export default async function setup(): Promise<void> {
  const env = environmentForTests();
  await lockTestTarget(env);
  const db = new PrismaClient({ datasourceUrl: env['DATABASE_URL'] });
  try {
    // [AUDIT C2-5] billing_events refuses a DELETE (migration 20261113100000) unless the session's purge is on. The
    // disposable test database turns it on for every session it serves, so suites can clean up their own fixtures; it
    // reaches only this locked target, and production never sets it. A test of the guard turns it off for itself.
    await db.$executeRawUnsafe(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET swift.billing_events_purge = %L', current_database(), 'on'); END $$`);
    const result = await backfillBillingConfirmation(db);
    // eslint-disable-next-line no-console
    if (!result.alreadyComplete) console.log(`[billing cutover] test database: ${result.mapped} subscriptions mapped, confirmation clock READY`);
  } finally {
    await db.$disconnect();
  }
}
