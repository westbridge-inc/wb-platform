import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { assertClearOfParties } from '../integrity/party-authority';

/**
 * [Audit FABLE-01 B-1] Who may decide a loss-protection claim: the one rule in party-authority.ts, in a claim's words.
 * Nobody approves, rejects or records the payment of a claim they are on, through any account of theirs: the mover who
 * filed it or the customer it names. That goes for the second person of the two-person decision too. With a staff
 * account among them it goes to a SUPER_ADMIN who is not one of them.
 *
 * Approving and paying move money from Swift's reserve, so an identity under review refuses them outright. Closing a
 * case moves nothing and no case may be stuck, so a SUPER_ADMIN who is clear of it may still reject it then.
 *
 * Call it inside the claim's transaction. It reads, and locks nothing.
 */
export async function assertMayDecideClaim(
  tx: Prisma.TransactionClient,
  actorId: string,
  claimId: string,
  approvalId: string | null | undefined,
  options: { closing?: boolean } = {},
): Promise<void> {
  const claim = await tx.reimbursementClaim.findUnique({ where: { id: claimId }, select: { customerId: true, orderId: true, riderId: true, driverId: true } });
  // A missing claim is the transition's own refusal to give.
  if (!claim) return;
  // One statement at a time: a transaction client runs on one connection.
  const order = await tx.order.findUnique({ where: { id: claim.orderId }, select: { customerId: true } });
  const rider = claim.riderId ? await tx.rider.findUnique({ where: { id: claim.riderId }, select: { userId: true } }) : null;
  const driver = claim.driverId ? await tx.driver.findUnique({ where: { id: claim.driverId }, select: { userId: true } }) : null;
  const parties = [...new Set([claim.customerId, order?.customerId, rider?.userId, driver?.userId].filter((id): id is string => !!id))];
  const staff = new AppError(403, 'STAFF_ON_CLAIM', 'A staff account is on this claim. Only a SUPER_ADMIN who is not on it can decide it.');
  const through = { superAdminThroughReview: options.closing === true };
  if (approvalId) {
    const approval = await tx.privilegedApproval.findUnique({ where: { id: approvalId }, select: { approvedBy: true, entityId: true } });
    if (!approval?.approvedBy || approval.entityId !== claimId) {
      throw new AppError(403, 'APPROVAL_NOT_FOUND', 'This approval could not be read for this claim. Ask for a new one.');
    }
    await assertClearOfParties(tx, approval.approvedBy, parties, {
      own: new AppError(403, 'APPROVER_ON_CLAIM', 'The admin who approved this is on the claim. Ask someone else to approve it.'),
      staff,
    }, through);
  }
  await assertClearOfParties(tx, actorId, parties, {
    own: new AppError(403, 'OWN_CLAIM', 'You are on this claim. Someone else at Swift must decide it.'),
    staff,
  }, through);
}
