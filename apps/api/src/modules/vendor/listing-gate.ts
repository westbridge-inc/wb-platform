import type { PrismaClient } from '@prisma/client';
import type { VerificationService } from '../verification/verification.service';

/**
 * The listing gate's answer (gated-trials spec §B2), for the store's own dashboard and for a Swift admin adding items
 * for the store (admin assisted setup): one rule. Verified stores list freely. With PREVIEW_MODE on, a store that has
 * NEVER been live (pending approval) may build its menu as DRAFTS — customer surfaces only show ACTIVE stores, so
 * nothing leaks — and goes live the minute verification lands. A store that HAS been live (ACTIVE/SUSPENDED) keeps the
 * hard gate: suspension means suspended. The verification gate belongs to the BUSINESS (its owner), not to whoever is
 * signed in.
 */
export async function listingAllowed(
  prisma: PrismaClient,
  verification: Pick<VerificationService, 'isRoleVerified'>,
  vendorId: string,
): Promise<boolean> {
  const vendorRecord = await prisma.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { isVerified: true, vendorType: true, status: true, owner: { select: { userId: true } } },
  });
  const verified = vendorRecord.isVerified
    || await verification.isRoleVerified(vendorRecord.owner.userId, vendorRecord.vendorType, prisma, vendorId);
  if (verified) return true;
  const draftableStatus = vendorRecord.status !== 'ACTIVE' && vendorRecord.status !== 'SUSPENDED';
  return process.env['PREVIEW_MODE'] === '1' && draftableStatus;
}
