import type { Prisma } from '@prisma/client';
import { revokeUserDevices } from '../../lib/owner-rls';
import { retireMoverSessionAuthorityInTransaction, type MoverSessionRevocationCleanup } from '../mover-authority';
import { persistMoverRevocationOutboxInTransaction } from '../mover-revocation-outbox';

/**
 * Global revocation core: every API session of the person ends, every registered device is silenced, and any mover
 * authority those sessions held is retired through the durable outbox. The caller MUST hold the canonical User lock
 * and run the post-commit tail (completeMoverSessionRevocation, socket disconnect). ONE implementation for log out
 * everywhere, a password reset, and [COMPANY-DOCS Part 3] the old account holder of a handed-over store account.
 */
export async function revokeAllSessionsInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  dedupeKey: string,
): Promise<MoverSessionRevocationCleanup> {
  const moverCleanup = await retireMoverSessionAuthorityInTransaction(tx, userId, null);
  const outboxId = await persistMoverRevocationOutboxInTransaction(tx, {
    dedupeKey,
    userId,
    cleanup: moverCleanup,
  });
  await tx.session.deleteMany({ where: { userId } });
  // Global revocation (logout-all, password reset) must silence a lost or
  // stolen device as well as its API session. A future sign-in explicitly
  // re-registers and reactivates the token on the current account.
  // [item 20] Through the narrow action: an admin-forced reset acts for someone else (owner wall).
  await revokeUserDevices(tx, userId);
  return { ...moverCleanup, outboxId };
}
