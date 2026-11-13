import type { Prisma } from '@prisma/client';
import type { AppError } from '../../utils/errors';
import { consoleRoleOf } from '../auth/console-role';
import { identityAuthority, identityLineage, IdentityReviewRequiredError } from './identity-review';

/**
 * Who at Swift may decide a matter that names people. One rule for every such door:
 *  - nobody decides their own matter, through any account of theirs;
 *  - an identity under review refuses: nobody can say who is linked to it, so nobody can say who is clear of it. A door
 *    that must never stay stuck may let a SUPER_ADMIN through (`superAdminThroughReview`) and records why. The parties'
 *    list can be short then, so the actor is read from their own side: under review, or anywhere on a party's lineage,
 *    they are refused. A degraded record alone never refuses that door, or the matter would have no exit;
 *  - with a staff account among the people, or linked to them, it goes to a SUPER_ADMIN who is not one of them, so a
 *    colleague's matter is never out of everyone's reach.
 *
 * Call it inside the door's transaction, on the people its locked row names. The roles are the database's at that moment,
 * never the session's: the guard ran earlier. It reads the rows and locks none, because the house order is User before
 * Order and a caller here already holds the later lock.
 */
export async function assertClearOfParties(
  tx: Prisma.TransactionClient,
  actorId: string,
  parties: readonly string[],
  refusals: { own: AppError; staff: AppError },
  options: {
    superAdminThroughReview?: boolean;
    /**
     * [Review A S4-D on #2502] ONLY for a second person's REVIEW of a staff member's own decision, a review that moves
     * no money (today: reviewOwnerLateCredit, the owner's late MMG credit). Names that decider, who must be one of the
     * parties: their console role (and their own linked accounts') does not send the review to a SUPER_ADMIN, since the
     * owner is always staff and his act must be reviewable by someone other than him. Every other party's staff role,
     * and the own-account and linked-identity rules for every party (the decider included), hold in full.
     * A money door never passes it (census: party-authority-review-exemption.test.ts).
     */
    reviewOfStaffDecisionBy?: string;
  } = {},
): Promise<{ identityReviewReasons: string[] }> {
  const decider = options.reviewOfStaffDecisionBy;
  if (decider !== undefined && !parties.includes(decider)) throw new Error('reviewOfStaffDecisionBy must name one of the parties');
  const people = new Set(parties);
  const deciderSide = new Set<string>(decider === undefined ? [] : [decider]);
  const reasons = new Set<string>();
  for (const party of parties) {
    const identity = await identityAuthority(tx, party);
    if (identity.status === 'REVIEW_REQUIRED') reasons.add(identity.reason);
    for (const member of identity.memberIds) {
      people.add(member);
      if (party === decider) deciderSide.add(member);
    }
  }
  if (people.has(actorId)) throw refusals.own;
  const rows = await tx.user.findMany({ where: { id: { in: [actorId, ...people] } }, select: { id: true, roles: true } });
  const consoleRole = (userId: string) => consoleRoleOf(rows.find((row) => row.id === userId)?.roles);
  if (reasons.size > 0) {
    if (!(options.superAdminThroughReview && consoleRole(actorId) === 'SUPER_ADMIN')) throw new IdentityReviewRequiredError();
    await assertActorClearOfLineage(tx, actorId, parties, refusals.own);
  }
  if ([...people].some((person) => !deciderSide.has(person) && consoleRole(person) !== null) && consoleRole(actorId) !== 'SUPER_ADMIN') throw refusals.staff;
  return { identityReviewReasons: [...reasons] };
}

/** The actor's side of a review: their own record must be whole, and no cluster on it may be on a party's. */
async function assertActorClearOfLineage(tx: Prisma.TransactionClient, actorId: string, parties: readonly string[], own: AppError): Promise<void> {
  if ((await identityAuthority(tx, actorId)).status === 'REVIEW_REQUIRED') throw new IdentityReviewRequiredError();
  const actorLineage = new Set(await identityLineage(tx, actorId));
  for (const party of parties) {
    if ((await identityLineage(tx, party)).some((clusterId) => actorLineage.has(clusterId))) throw own;
  }
}
