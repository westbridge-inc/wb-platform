import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { approverRoster } from '../admin/solo-approval';

/**
 * [ASSISTED SETUP · owner 12 Nov 2026] "Approving a paper the same admin uploaded must be flagged (second-person approval
 * when a second admin exists)." A paper a Swift admin uploaded for a store (verification_documents."assistedById") is
 * approved by ANOTHER admin whenever one exists: the admins counted live (every ADMIN or SUPER_ADMIN account that can
 * still sign in, in this market — solo-approval's roster; over-counting refuses, the safe direction). While the uploader
 * is the only admin, they may approve it only by saying "I checked it myself, no second admin available", which the
 * approval's audit row records. Rejecting is never limited: a refusal grants nothing.
 */
export const SAME_UPLOADER_REFUSED = 'ASSISTED_UPLOADER_CANNOT_APPROVE';
export const SAME_UPLOADER_ACK_REQUIRED = 'ASSISTED_UPLOADER_ACK_REQUIRED';

export const SAME_UPLOADER_REFUSED_WORDS =
  'You uploaded this paper for the store, so another admin must approve it. Ask a second admin to check it in the Review Center.';
export const SAME_UPLOADER_ACK_WORDS =
  'You uploaded this paper for the store. There is no second admin, so you may approve it only if you checked it yourself: tick "I checked it myself, no second admin available".';

/** The live count of people who could take a second look: ADMIN or SUPER_ADMIN accounts that can still sign in. */
export async function adminCount(db: Pick<PrismaClient, 'user'>): Promise<number> {
  return (await approverRoster(db)).length;
}

/**
 * The same-person rule at the decision. Returns 'sole-admin-checked' when the uploader approves alone with the
 * acknowledgement (the caller audits it), 'not-uploader' when the rule does not apply; throws otherwise.
 */
export async function sameUploaderDecision(
  db: Pick<PrismaClient, 'user'>,
  doc: { assistedById: string | null },
  adminId: string,
  soleAdminChecked: boolean,
): Promise<'not-uploader' | 'sole-admin-checked'> {
  if (!doc.assistedById || doc.assistedById !== adminId) return 'not-uploader';
  if ((await adminCount(db)) > 1) throw new AppError(403, SAME_UPLOADER_REFUSED, SAME_UPLOADER_REFUSED_WORDS);
  if (!soleAdminChecked) throw new AppError(409, SAME_UPLOADER_ACK_REQUIRED, SAME_UPLOADER_ACK_WORDS);
  return 'sole-admin-checked';
}
