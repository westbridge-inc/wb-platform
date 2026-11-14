import type { Prisma } from '@prisma/client';
import { currentDunningClock, lockBillingAuthority } from './dunning-clock';
import { lockFeeCollectionAuthority } from '../subscription/mover-fee-authority';

/**
 * Trial conversion of ONE row, inside the caller's transaction: a trial whose days have elapsed becomes ACTIVE and
 * immediately due (its first fee falls due at the trial's end). Under the payer's locks, then the obligation's clock
 * is read (mapped) at `now`, preserving the original obligation and any time already paused. Returns false, changing
 * nothing, when the row is not a TRIAL past its end or the payer's fee authority does not allow collection.
 * SubscriptionService.convertExpiredTrials runs it for every such row; [TRIAL PAY-AHEAD · REVIEW-A #2513 S3-2] the
 * refund set-aside runs it for the one account first, so a started first week is paid before any credit is refunded.
 */
export async function convertEndedTrialInTx(tx: Prisma.TransactionClient, subscriptionId: string, now: Date): Promise<boolean> {
  if (!(await lockFeeCollectionAuthority(tx, subscriptionId)).allowed) return false;
  const { sub } = await lockBillingAuthority(tx, subscriptionId);
  if (sub.status !== 'TRIAL' || !sub.trialEndDate || sub.trialEndDate > now) return false;
  await tx.subscription.update({ where: { id: subscriptionId }, data: { status: 'ACTIVE', isTrialActive: false } });
  await currentDunningClock(tx, subscriptionId, now);
  return true;
}
